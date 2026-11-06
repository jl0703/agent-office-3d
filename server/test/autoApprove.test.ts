import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startServer, type RunningServer } from "../src/app.ts";
import { AUTO_APPROVE_FILE, createAutoApproveStore, namesOutsidePath, type AutoApproveStore } from "../src/autoApprove.ts";
import { OFFICE_SERVER } from "../src/officeTools.ts";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor } from "../src/supervisor.ts";
import { createFake } from "./fakeQuery.ts";
import { loginTo, send, validPlan } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
  await Promise.all(servers.map((s) => s.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function rig({ store, ...opts }: { totalBudgetUsd?: number; store?: AutoApproveStore } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoapp-"));
  dirs.push(root);
  const work = join(root, "demo");
  const research = join(root, "research");
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(research);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const staticDir = join(root, "dist");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<p>x</p>");
  const dataDir = join(root, "data");
  const registry = createRegistry();
  const f = createFake();
  const autoApprove = store ?? createAutoApproveStore(dataDir);
  const logs: Record<string, unknown>[] = [];
  const supervisor = createSupervisor({ registry, query: f.query, roots: [root], env: {}, stopGraceMs: 150, startTimeoutMs: 1000, dataDir, researchDir: research, maxMasters: 40, maxManaged: 40, autoApprove, log: (l) => logs.push(l), ...opts });
  closers.push(() => supervisor.close());
  const srv = await startServer({ port: 0, staticDir, registry, supervisor, autoApprove, log: () => {} });
  servers.push(srv);
  const auth = await loginTo(srv);
  const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
  const post = (body: unknown) => send(srv.port, "/api/auto-approve", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
  const get = () => send(srv.port, "/api/auto-approve", { method: "GET", headers });

  let next = 0;
  /** Starts a master and returns its id and a caller for its office tools. */
  const master = async () => {
    const res = await supervisor.startMaster({ cwd: work, prompt: "the goal" });
    assert.ok(res.ok);
    const session = next++;
    const server = f.calls[session]?.mcpServers?.[OFFICE_SERVER] as { instance: { connect(t: unknown): Promise<void> } };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    closers.push(() => client.close());
    const call = async (name: string, args: object = {}) => {
      const out = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: { text: string }[] };
      return { error: out.isError === true, text: out.content[0]?.text ?? "" };
    };
    return { id: res.id, session, call };
  };
  const enable = (more: object = {}) => autoApprove.update({ enabled: true, ...more });
  return { srv, root, work, outside, dataDir, registry, supervisor, autoApprove, logs, post, get, master, enable, ...f };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const plan = (r: Rig, id: string) => r.registry.get(id)?.plan;
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (Date.now() < end && !check()) await new Promise((res) => setTimeout(res, 10));
  assert.ok(check(), "condition met");
}
const reasons = (r: Rig) => r.logs.filter((l) => l["event"] === "plan-needs-owner").map((l) => l["reason"]);

describe("auto-approve: the plan gate", () => {
  it("is off by default: a qualifying plan stays pending", async () => {
    const r = await rig();
    const { id, call } = await r.master();
    assert.equal((await call("submit_plan", validPlan)).error, false);
    assert.equal(plan(r, id)?.status, "pending");
    assert.equal(r.registry.get(id)?.phase, "planning");
    assert.deepEqual(reasons(r), ["disabled"]);
  });

  it("approves a qualifying plan like the owner's approve, marks it auto and tells the master", async () => {
    const r = await rig();
    await r.enable();
    const { id, session, call } = await r.master();
    assert.equal((await call("submit_plan", { ...validPlan, files: ["src/a.ts", "new/dir/b.ts"], workers: 1, costUsd: 0.5 })).error, false);
    const p = plan(r, id);
    assert.equal(p?.status, "approved");
    assert.equal(p?.auto, true);
    assert.equal(r.registry.get(id)?.phase, "executing");
    assert.equal(r.sessions[session]?.prompts[1]?.message.content, "Your plan was approved automatically by the owner's rule. Go ahead.");
    assert.equal(r.registry.get(id)?.currentTask, "Your plan was approved automatically by the owner's rule. Go ahead.");
    assert.equal(r.logs.filter((l) => l["event"] === "plan-auto-approved").length, 1);
  });

  it("an owner's approval carries no auto flag", async () => {
    const r = await rig();
    const { id, call } = await r.master();
    await call("submit_plan", validPlan);
    assert.equal(r.supervisor.decidePlan(id, "approve").ok, true);
    assert.equal(plan(r, id)?.auto, undefined);
  });

  it("stays pending above the cost limit and approves at exactly the limit", async () => {
    const r = await rig();
    await r.enable({ maxCostUsd: 0.5 });
    const over = await r.master();
    await over.call("submit_plan", { ...validPlan, costUsd: 0.51 });
    assert.equal(plan(r, over.id)?.status, "pending");
    const at = await r.master();
    await at.call("submit_plan", { ...validPlan, costUsd: 0.5 });
    assert.equal(plan(r, at.id)?.status, "approved");
    assert.deepEqual(reasons(r), ["cost"]);
  });

  it("stays pending above the worker limit", async () => {
    const r = await rig();
    await r.enable({ maxWorkers: 1 });
    const { id, call } = await r.master();
    await call("submit_plan", { ...validPlan, workers: 2 });
    assert.equal(plan(r, id)?.status, "pending");
    assert.deepEqual(reasons(r), ["workers"]);
  });

  it("stays pending with 0 or 6 files, and approves 1 and 5", async () => {
    const r = await rig();
    await r.enable();
    for (const files of [[], ["a", "b", "c", "d", "e", "f"]]) {
      const m = await r.master();
      await m.call("submit_plan", { ...validPlan, files });
      assert.equal(plan(r, m.id)?.status, "pending", `${files.length} files`);
    }
    for (const files of [["a"], ["a", "b", "c", "d", "e"]]) {
      const m = await r.master();
      await m.call("submit_plan", { ...validPlan, files });
      assert.equal(plan(r, m.id)?.status, "approved", `${files.length} files`);
    }
  });

  it("stays pending for a file outside the master's folder", async () => {
    const r = await rig();
    await r.enable();
    const bad = [
      "../outside/x.ts",
      "sub/../../outside/x.ts",
      "sub\\..\\..\\outside\\x.ts",
      join(r.outside, "x.ts"),
      "\\\\server\\share\\x.ts",
      "//server/share/x.ts",
      "C:x.ts",
      "D:\\x.ts",
      "a.ts:stream",
      "a\u0000.ts",
      "a\n.ts",
      "a\u202e.ts",
      ".",
    ];
    for (const file of bad) {
      const m = await r.master();
      await m.call("submit_plan", { ...validPlan, files: ["src/ok.ts", file] });
      assert.equal(plan(r, m.id)?.status, "pending", JSON.stringify(file));
    }
  });

  it("stays pending for a link that leads out of the folder, and approves a link that stays inside", async () => {
    const r = await rig();
    await r.enable();
    try {
      symlinkSync(r.outside, join(r.work, "escape"), "junction");
      symlinkSync(join(r.work, "sub"), join(r.work, "inner"), "junction");
    } catch {
      return; // links cannot be created here
    }
    const out = await r.master();
    await out.call("submit_plan", { ...validPlan, files: ["escape/x.ts"] });
    assert.equal(plan(r, out.id)?.status, "pending");
    const inside = await r.master();
    await inside.call("submit_plan", { ...validPlan, files: ["inner/x.ts"] });
    assert.equal(plan(r, inside.id)?.status, "approved");
  });

  it("an absolute path inside the folder is allowed", async () => {
    const r = await rig();
    await r.enable();
    const m = await r.master();
    await m.call("submit_plan", { ...validPlan, files: [join(r.work, "sub", "x.ts")] });
    assert.equal(plan(r, m.id)?.status, "approved");
  });

  it("a plan already pending is not touched by enabling later", async () => {
    const r = await rig();
    const { id, call } = await r.master();
    await call("submit_plan", validPlan);
    await r.enable();
    assert.equal(plan(r, id)?.status, "pending");
    assert.equal(r.supervisor.decidePlan(id, "changes").ok, true);
    await call("submit_plan", validPlan);
    assert.equal(plan(r, id)?.status, "approved", "a later plan is judged by the new rule");
  });

  it("turning it off applies to the next plan only", async () => {
    const r = await rig();
    await r.enable();
    const first = await r.master();
    await first.call("submit_plan", validPlan);
    await r.autoApprove.update({ enabled: false });
    const second = await r.master();
    await second.call("submit_plan", validPlan);
    assert.equal(plan(r, first.id)?.status, "approved");
    assert.equal(plan(r, second.id)?.status, "pending");
  });

  it("stays pending when the usage cap is reached, while the master is still running", async () => {
    const r = await rig({ totalBudgetUsd: 0.01 });
    await r.enable();
    const spender = await r.master();
    const waiting = await r.master();
    r.sessions[spender.session]?.out.push({ type: "result", subtype: "success", total_cost_usd: 0.02, session_id: "x" } as never);
    await waitFor(() => r.registry.get(spender.id)?.status === "stopped" || r.logs.some((l) => l["event"] === "managed-cap"));
    assert.equal((await waiting.call("submit_plan", validPlan)).error, false);
    assert.equal(plan(r, waiting.id)?.status, "pending");
    assert.equal(r.registry.get(waiting.id)?.phase, "planning");
    assert.deepEqual(reasons(r), ["budget"]);
  });

  it("switching the rule off while the files are checked wins", async () => {
    let reads = 0;
    const flip = { enabled: true, maxCostUsd: 0.5, maxWorkers: 1 };
    const r = await rig({ store: { get: async () => ({ ...flip, enabled: ++reads < 2 }), update: async () => flip } as never });
    const { id, call } = await r.master();
    await call("submit_plan", validPlan);
    assert.equal(reads, 2);
    assert.equal(plan(r, id)?.status, "pending");
    assert.deepEqual(reasons(r), ["disabled"]);
  });

  it("never touches the research sweep's Lead", async () => {
    const r = await rig();
    await r.enable();
    const res = await r.supervisor.startSweep("sweep");
    assert.ok(res.ok);
    const server = r.calls[0]?.mcpServers?.[OFFICE_SERVER] as { instance: { connect(t: unknown): Promise<void> } };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    closers.push(() => client.close());
    const out = (await client.callTool({ name: "submit_plan", arguments: validPlan })) as { isError?: boolean };
    assert.equal(out.isError, true);
    assert.equal(r.registry.get(res.id)?.plan ?? null, null);
    assert.equal(r.logs.filter((l) => l["event"] === "plan-auto-approved").length, 0);
  });

  it("the model cannot set the auto flag itself", async () => {
    const r = await rig();
    const { id, call } = await r.master();
    await call("submit_plan", { ...validPlan, auto: true });
    assert.equal(plan(r, id)?.auto, undefined);
  });
});

describe("auto-approve: settings", () => {
  it("defaults to off with 0.5 and 1, and a corrupt file reads as the defaults and is set aside", async () => {
    const r = await rig();
    mkdirSync(r.dataDir, { recursive: true });
    writeFileSync(join(r.dataDir, AUTO_APPROVE_FILE), '{"version":1,"enabled":true,"maxCostUsd":9,"maxWorkers":1}');
    const store = createAutoApproveStore(r.dataDir);
    assert.deepEqual(await store.get(), { enabled: false, maxCostUsd: 0.5, maxWorkers: 1 });
    assert.equal(readFileSync(join(r.dataDir, `${AUTO_APPROVE_FILE}.bad`), "utf8").includes('"enabled":true'), true);
    writeFileSync(join(r.dataDir, AUTO_APPROVE_FILE), "not json");
    assert.equal((await createAutoApproveStore(r.dataDir).get()).enabled, false);
  });

  it("GET shows the settings and POST saves them to the file", async () => {
    const r = await rig();
    assert.deepEqual(JSON.parse((await r.get()).body), { enabled: false, maxCostUsd: 0.5, maxWorkers: 1 });
    const res = await r.post({ enabled: true, maxCostUsd: 1.5, maxWorkers: 3 });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { enabled: true, maxCostUsd: 1.5, maxWorkers: 3 });
    assert.deepEqual(JSON.parse(readFileSync(join(r.dataDir, AUTO_APPROVE_FILE), "utf8")), { version: 1, enabled: true, maxCostUsd: 1.5, maxWorkers: 3 });
    assert.deepEqual(await createAutoApproveStore(r.dataDir).get(), { enabled: true, maxCostUsd: 1.5, maxWorkers: 3 });
  });

  it("POST with one key keeps the others", async () => {
    const r = await rig();
    await r.post({ maxWorkers: 2 });
    assert.deepEqual(JSON.parse((await r.post({ enabled: true })).body), { enabled: true, maxCostUsd: 0.5, maxWorkers: 2 });
  });

  it("POST is strict: unknown keys, empty body, wrong types and out-of-range numbers give 400", async () => {
    const r = await rig();
    const bad = [{}, { x: 1 }, { enabled: true, extra: 1 }, { enabled: "yes" }, { maxCostUsd: 2.01 }, { maxCostUsd: -0.1 }, { maxWorkers: 4 }, { maxWorkers: 1.5 }, { maxWorkers: -1 }, "[]"];
    for (const body of bad) {
      const res = await r.post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(JSON.parse(res.body), { error: "invalid_request" });
    }
    assert.equal((await r.post("not json")).status, 400);
    assert.deepEqual(await r.autoApprove.get(), { enabled: false, maxCostUsd: 0.5, maxWorkers: 1 });
  });

  it("the routes need a session", async () => {
    const r = await rig();
    const res = await send(r.srv.port, "/api/auto-approve", { method: "GET", headers: { host: `127.0.0.1:${r.srv.port}` } });
    assert.equal(res.status, 403);
  });
});

describe("auto-approve: paths named in the plan's words", () => {
  const withPlan = (over: Partial<typeof validPlan>) => ({ ...validPlan, ...over });

  it("flags a root, home, drive, UNC or `..` path anywhere in the text, and leaves ordinary text alone", () => {
    for (const text of ["edit /etc/hosts", "copy to C:\\Users\\x", "read ~/notes", "see \\\\server\\share", "open ../other/file", "cd .. && ls", "(/var/log)", "x\\..\\y"]) {
      assert.equal(namesOutsidePath(withPlan({ steps: [text] })), true, text);
    }
    assert.equal(namesOutsidePath(withPlan({ undo: "rm /tmp/x" })), true);
    assert.equal(namesOutsidePath(withPlan({ goal: "use https://example.com/a and/or src/a.ts, then wait... done" })), false);
    assert.equal(namesOutsidePath(withPlan({})), false);
  });

  it("sends a plan with such a path to the owner even when its files list is fine", async () => {
    const r = await rig();
    await r.enable();
    const { id, call } = await r.master();
    await call("submit_plan", { ...validPlan, steps: ["read the code", "also change /etc/hosts"] });
    assert.equal(plan(r, id)?.status, "pending");
    assert.deepEqual(reasons(r), ["paths"]);
  });
});
