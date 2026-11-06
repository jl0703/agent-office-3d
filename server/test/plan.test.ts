import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startServer, type RunningServer } from "../src/app.ts";
import { loadStore, saveStore, STORE_FILE } from "../src/managedStore.ts";
import { OFFICE_SERVER } from "../src/officeTools.ts";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor } from "../src/supervisor.ts";
import { createFake, storedWorker } from "./fakeQuery.ts";
import { loginTo, send, validPlan } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
  await Promise.all(servers.map((s) => s.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "plan-"));
  dirs.push(root);
  const work = join(root, "demo");
  const research = join(root, "research");
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(research);
  const staticDir = join(root, "dist");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<p>x</p>");
  const dataDir = join(root, "data");
  const registry = createRegistry();
  const f = createFake();
  const supervisor = createSupervisor({ registry, query: f.query, roots: [root], env: {}, stopGraceMs: 150, startTimeoutMs: 1000, dataDir, researchDir: research, maxMasters: 3, log: () => {} });
  closers.push(() => supervisor.close());
  const srv = await startServer({ port: 0, staticDir, registry, supervisor, log: () => {} });
  servers.push(srv);
  const auth = await loginTo(srv);
  const headers = (more: Record<string, string> = {}) => ({ host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json", ...more });
  const post = (path: string, body: unknown = {}, more: Record<string, string> = {}) =>
    send(srv.port, path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: headers(more) });
  const decide = (id: string, body: unknown) => post(`/api/agents/${id}/plan`, body);

  const callers = new Map<number, (name: string, args?: object) => Promise<{ error: boolean; text: string }>>();
  /** Calls a session's office tools the way the model does. */
  const office = async (session: number) => {
    const known = callers.get(session);
    if (known) return known;
    const server = f.calls[session]?.mcpServers?.[OFFICE_SERVER] as { instance: { connect(t: unknown): Promise<void> } };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    closers.push(() => client.close());
    const call = async (name: string, args: object = {}) => {
      const res = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: { text: string }[] };
      return { error: res.isError === true, text: res.content[0]?.text ?? "" };
    };
    callers.set(session, call);
    return call;
  };
  const master = async () => {
    const res = await supervisor.startMaster({ cwd: work, prompt: "the goal" });
    assert.ok(res.ok);
    return res.id;
  };
  const hook = (session: number, tool: string, input: object) =>
    f.calls[session]?.hooks?.PreToolUse?.[0]?.hooks[0]?.({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal }) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  return { root, work, research, dataDir, registry, supervisor, srv, auth, post, decide, office, master, hook, ...f };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition met");
}

/** A master with a pending plan. */
async function planned(r: Rig) {
  const id = await r.master();
  const call = await r.office(0);
  assert.equal((await call("submit_plan", validPlan)).error, false);
  return { id, call };
}

describe("plan gate: the planning phase", () => {
  it("starts every master in planning, with no plan, and shows both on the agent", async () => {
    const r = await rig();
    const id = await r.master();
    const agent = r.registry.get(id);
    assert.equal(agent?.phase, "planning");
    assert.equal(agent?.plan, null);
    const worker = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(worker.ok);
    assert.equal(r.registry.get(worker.id)?.phase, undefined, "workers have no phase");
  });

  it("refuses spawn_worker with plan_not_approved and starts nothing", async () => {
    const r = await rig();
    await r.master();
    const call = await r.office(0);
    const res = await call("spawn_worker", { name: "A", folder: r.work, task: "t" });
    assert.equal(res.error, true);
    assert.match(res.text, /^plan_not_approved/);
    assert.equal(r.calls.length, 1);
  });

  it("denies Write and Edit in the folder guard while planning, keeps reads, and allows writes once approved", async () => {
    const r = await rig();
    const id = await r.master();
    const file = join(r.work, "a.txt");
    for (const tool of ["Write", "Edit"]) assert.equal((await r.hook(0, tool, { file_path: file }))?.hookSpecificOutput?.permissionDecision, "deny", tool);
    for (const [tool, input] of [["Read", { file_path: file }], ["Glob", { pattern: "*.ts" }], ["Grep", { pattern: "x" }], ["WebSearch", {}]] as const) {
      assert.deepEqual(await r.hook(0, tool, input), {}, tool);
    }
    const call = await r.office(0);
    await call("submit_plan", validPlan);
    assert.equal(r.supervisor.decidePlan(id, "approve").ok, true);
    assert.deepEqual(await r.hook(0, "Write", { file_path: file }), {});
  });
});

describe("submit_plan", () => {
  it("stores a pending plan, tells the master to wait, and a new submit replaces it after changes were asked", async () => {
    const r = await rig();
    const id = await r.master();
    const call = await r.office(0);
    const first = await call("submit_plan", validPlan);
    assert.equal(first.error, false);
    assert.match(first.text, /Wait for the owner's decision/);
    assert.deepEqual(r.registry.get(id)?.plan, { ...validPlan, status: "pending" });
    r.supervisor.decidePlan(id, "changes");
    await call("submit_plan", { ...validPlan, goal: "Another goal" });
    assert.equal(r.registry.get(id)?.plan?.goal, "Another goal");
  });

  it("rejects malformed plans", async () => {
    const r = await rig();
    const id = await r.master();
    const call = await r.office(0);
    const bad = [
      { ...validPlan, goal: "x".repeat(301) },
      { ...validPlan, goal: undefined },
      { ...validPlan, steps: [] },
      { ...validPlan, steps: Array(13).fill("s") },
      { ...validPlan, steps: ["x".repeat(201)] },
      { ...validPlan, files: Array(21).fill("f") },
      { ...validPlan, workers: 6 },
      { ...validPlan, workers: 1.5 },
      { ...validPlan, costUsd: 51 },
      { ...validPlan, costUsd: -1 },
      { ...validPlan, risks: "x".repeat(501) },
      { ...validPlan, undo: "x".repeat(501) },
    ];
    for (const args of bad) assert.equal((await call("submit_plan", args)).error, true, JSON.stringify(args).slice(0, 80));
    assert.equal(r.registry.get(id)?.plan, null);
    assert.equal((await call("submit_plan", { ...validPlan, files: [], workers: 0, costUsd: 0 })).error, false, "the lower bounds are allowed");
  });

  it("is refused while the current plan is pending, and allowed again after changes were asked", async () => {
    const r = await rig();
    const { id, call } = await planned(r);
    const again = await call("submit_plan", { ...validPlan, goal: "Sneaky" });
    assert.equal(again.error, true);
    assert.match(again.text, /waiting for the owner's decision/);
    assert.equal(r.registry.get(id)?.plan?.goal, validPlan.goal);
    r.supervisor.decidePlan(id, "changes", "smaller");
    assert.equal((await call("submit_plan", { ...validPlan, goal: "Smaller" })).error, false);
    assert.equal(r.registry.get(id)?.plan?.goal, "Smaller");
  });

  it("is refused once the plan is approved", async () => {
    const r = await rig();
    const { id, call } = await planned(r);
    r.supervisor.decidePlan(id, "approve");
    const again = await call("submit_plan", validPlan);
    assert.equal(again.error, true);
    assert.equal(r.registry.get(id)?.plan?.status, "approved");
  });
});

describe("POST /api/agents/:id/plan", () => {
  it("approve unlocks spawn_worker, flips the phase and sends the master the go-ahead", async () => {
    const r = await rig();
    const { id, call } = await planned(r);
    const res = await r.decide(id, { decision: "approve" });
    assert.equal(res.status, 202);
    assert.equal(r.registry.get(id)?.phase, "executing");
    assert.equal(r.registry.get(id)?.plan?.status, "approved");
    await waitFor(() => r.sessions[0]?.prompts.length === 2);
    assert.equal(r.sessions[0]?.prompts[1]?.message.content, "Your plan was approved. Go ahead.");
    const spawned = await call("spawn_worker", { name: "A", folder: r.work, task: "t" });
    assert.equal(spawned.error, false, spawned.text);
  });

  it("changes sends the note as the next message and stays in planning; a revised plan can follow", async () => {
    const r = await rig();
    const { id, call } = await planned(r);
    assert.equal((await r.decide(id, { decision: "changes", note: "use fewer workers" })).status, 202);
    assert.deepEqual([r.registry.get(id)?.phase, r.registry.get(id)?.plan?.status, r.registry.get(id)?.plan?.note], ["planning", "changes", "use fewer workers"]);
    await waitFor(() => r.sessions[0]?.prompts.length === 2);
    assert.equal(r.sessions[0]?.prompts[1]?.message.content, "The owner asked for changes: use fewer workers. Revise and submit_plan again.");
    assert.equal(r.registry.get(id)?.currentTask, "The owner asked for changes: use fewer workers. Revise and submit_plan again.");
    assert.match((await call("spawn_worker", { name: "A", folder: r.work, task: "t" })).text, /plan_not_approved/);
    await call("submit_plan", { ...validPlan, workers: 0 });
    assert.deepEqual([r.registry.get(id)?.plan?.status, r.registry.get(id)?.plan?.workers], ["pending", 0]);
    assert.equal(r.registry.get(id)?.plan?.note, undefined, "the new plan has no old note");
  });

  it("reject stops the master with the end note Plan rejected.", async () => {
    const r = await rig();
    const { id } = await planned(r);
    assert.equal((await r.decide(id, { decision: "reject", note: "no" })).status, 202);
    await waitFor(() => r.registry.get(id)?.status === "stopped");
    assert.equal(r.registry.get(id)?.note, "Plan rejected.");
    assert.equal(r.registry.get(id)?.plan?.status, "rejected");
  });

  it("answers 409 no_pending_plan before a plan is submitted and after it was decided, and changes nothing", async () => {
    const r = await rig();
    const id = await r.master();
    const early = await r.decide(id, { decision: "approve" });
    assert.deepEqual([early.status, JSON.parse(early.body)], [409, { reason: "no_pending_plan" }]);
    assert.equal(r.registry.get(id)?.phase, "planning");
    const call = await r.office(0);
    await call("submit_plan", validPlan);
    await r.decide(id, { decision: "changes", note: "x" });
    const late = await r.decide(id, { decision: "approve" });
    assert.deepEqual([late.status, JSON.parse(late.body)], [409, { reason: "no_pending_plan" }]);
    assert.equal(r.registry.get(id)?.phase, "planning");
  });

  it("answers 404 for an unknown agent and for one that is not a master", async () => {
    const r = await rig();
    const worker = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(worker.ok);
    for (const id of ["nobody", worker.id]) {
      const res = await r.decide(id, { decision: "approve" });
      assert.deepEqual([res.status, JSON.parse(res.body)], [404, { error: "not_found" }], id);
    }
  });

  it("takes a strict body: unknown fields, bad decisions, long or multi-line notes and non-JSON are refused and change nothing", async () => {
    const r = await rig();
    const { id } = await planned(r);
    const cases: [unknown, number][] = [
      [{ decision: "approve", extra: 1 }, 400],
      [{ decision: "maybe" }, 400],
      [{}, 400],
      [{ decision: "changes", note: "x".repeat(501) }, 400],
      [{ decision: "changes", note: "line one\nline two" }, 400],
      [{ decision: "changes", note: 5 }, 400],
      ["{nope", 400],
      [[1], 400],
    ];
    for (const [body, status] of cases) assert.equal((await r.decide(id, body)).status, status, JSON.stringify(body).slice(0, 60));
    const plain = await send(r.srv.port, `/api/agents/${id}/plan`, { method: "POST", body: '{"decision":"approve"}', headers: { host: r.auth.host, cookie: r.auth.cookie, origin: `http://${r.auth.host}` } });
    assert.equal(plain.status, 415, "a JSON content type is required");
    assert.equal(r.registry.get(id)?.plan?.status, "pending");
    assert.equal(r.registry.get(id)?.phase, "planning");
  });

  it("needs the session and an allowed origin like the other agent routes", async () => {
    const r = await rig();
    const { id } = await planned(r);
    const body = JSON.stringify({ decision: "approve" });
    const headers = { host: r.auth.host, "content-type": "application/json" };
    assert.equal((await send(r.srv.port, `/api/agents/${id}/plan`, { method: "POST", body, headers: { ...headers, origin: `http://${r.auth.host}` } })).status, 403, "no session");
    assert.equal((await send(r.srv.port, `/api/agents/${id}/plan`, { method: "POST", body, headers: { ...headers, cookie: r.auth.cookie, origin: "http://evil.example" } })).status, 403, "bad origin");
    assert.equal(r.registry.get(id)?.phase, "planning");
  });
});

describe("resuming a master", () => {
  const refused = { ok: false, status: 409, code: "master_not_resumable" };

  it("is refused after reject, after stop and after a restart, and starts no session", async () => {
    const r = await rig();
    const { id } = await planned(r);
    await r.decide(id, { decision: "reject" });
    await waitFor(() => r.registry.get(id)?.status === "stopped");
    assert.deepEqual(await r.supervisor.resume(id), refused);

    const stopped = await r.master();
    await r.supervisor.stop(stopped);
    await waitFor(() => r.registry.get(stopped)?.status === "stopped");
    assert.deepEqual(await r.supervisor.resume(stopped), refused);

    await r.supervisor.settled();
    const registry = createRegistry();
    const again = createSupervisor({ registry, query: r.query, roots: [r.root], env: {}, dataDir: r.dataDir, log: () => {} });
    closers.push(() => again.close());
    await again.recover();
    const before = r.calls.length;
    assert.deepEqual(await again.resume(id), refused);
    assert.equal(r.calls.length, before);
    const http = await r.post(`/api/agents/${stopped}/resume`, {});
    assert.deepEqual([http.status, JSON.parse(http.body)], [409, { reason: "master_not_resumable" }]);
  });
});

describe("the research sweep Lead", () => {
  it("is exempt: it starts executing and may start workers at once", async () => {
    const r = await rig();
    const res = await r.supervisor.startSweep("sweep");
    assert.ok(res.ok);
    assert.equal(r.registry.get(res.id)?.phase, "executing");
    assert.equal((await r.hook(0, "Write", { file_path: join(r.research, "x.md") }))?.hookSpecificOutput, undefined);
    const call = await r.office(0);
    const spawned = await call("spawn_worker", { name: "ideas-scout", folder: r.research, task: "t" });
    assert.equal(spawned.error, false, spawned.text);
  });
});

describe("plan persistence", () => {
  it("keeps phase and plan across a restart, and shows the detached master with them", async () => {
    const r = await rig();
    const { id } = await planned(r);
    await r.supervisor.settled();
    const stored = (await loadStore(r.dataDir)).find((w) => w.id === id);
    assert.deepEqual([stored?.phase, stored?.plan], ["planning", { ...validPlan, status: "pending" }]);
    const registry = createRegistry();
    const again = createSupervisor({ registry, query: r.query, roots: [r.root], env: {}, dataDir: r.dataDir, log: () => {} });
    closers.push(() => again.close());
    await again.recover();
    const agent = registry.get(id);
    assert.deepEqual([agent?.role, agent?.status, agent?.phase, agent?.plan?.status], ["master", "detached", "planning", "pending"]);
  });

  it("still loads a store file from before the plan gate, and refuses a damaged plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-store-"));
    dirs.push(dir);
    await saveStore(dir, [storedWorker("old-1")]);
    const [w] = await loadStore(dir);
    assert.deepEqual([w?.id, w?.phase, w?.plan], ["old-1", undefined, undefined]);
    const bad = { version: 1, workers: [{ ...storedWorker("bad-1"), phase: "planning", plan: { goal: "x" } }] };
    writeFileSync(join(dir, STORE_FILE), JSON.stringify(bad));
    assert.deepEqual(await loadStore(dir), []);
  });
});
