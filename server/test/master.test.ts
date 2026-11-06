import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkToolCall } from "../src/folderGuard.ts";
import { lockdownOptions, MASTER_MAX_TURNS, MAX_TURNS, WORKER_TOOLS } from "../src/lockdown.ts";
import { loadStore, STORE_FILE } from "../src/managedStore.ts";
import { MASTER_SYSTEM_PROMPT, PLAN_FIRST_PROMPT, OFFICE_SERVER, OFFICE_TOOL_NAMES } from "../src/officeTools.ts";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor, type SupervisorOptions } from "../src/supervisor.ts";
import { validPlan } from "./helpers.ts";
import { createFake, type FakeOptions } from "./fakeQuery.ts";

const made: string[] = [];
const supervisors: ReturnType<typeof createSupervisor>[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(supervisors.map((s) => s.close()));
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows can keep a folder busy for a while after a test (a junction or a worker that just ended); the system temp folder is cleaned up eventually, and a failed cleanup must not fail the run.
    }
  }
});

const dir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

function rig(fake: FakeOptions = {}, extra: Partial<SupervisorOptions> = {}) {
  const root = dir("master-");
  const work = join(root, "demo"); // the master's folder
  const sub = join(work, "sub");
  const sibling = join(root, "sibling"); // allowed by the roots, but outside the master's folder
  mkdirSync(sub, { recursive: true });
  mkdirSync(sibling);
  const dataDir = join(root, "data");
  const registry = createRegistry();
  const logs: Record<string, unknown>[] = [];
  const f = createFake(fake);
  const supervisor = createSupervisor({
    registry,
    query: f.query,
    roots: [root],
    env: { PATH: "p", ANTHROPIC_API_KEY: "secret-key" },
    stopGraceMs: 150,
    startTimeoutMs: 400,
    dataDir,
    log: (l) => logs.push(l),
    ...extra,
  });
  supervisors.push(supervisor);
  const turnsEnded = () => logs.filter((l) => l["event"] === "managed-turn-end").length;
  return { root, work, sub, sibling, dataDir, registry, logs, supervisor, turnsEnded, ...f };
}
type Rig = ReturnType<typeof rig>;

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`condition not met within ${ms} ms`);
}

/** Starts a master. By default its plan is submitted and approved, so it may start workers. */
async function startMaster(r: Rig, cwd = r.work, approve = true) {
  const res = await r.supervisor.startMaster({ cwd, prompt: "the goal" });
  assert.ok(res.ok);
  if (approve) {
    const call = await officeFor(r, r.calls.length - 1);
    assert.equal((await call("submit_plan", validPlan)).error, false);
    assert.deepEqual(r.supervisor.decidePlan(res.id, "approve"), { ok: true });
  }
  return res.id;
}

/** Ends the current turn of a session, with the final text a worker would report. */
async function finishTurn(r: Rig, session: number, text = "done", cost = 0.1) {
  const before = r.turnsEnded();
  r.sessions[session]?.out.push({ type: "result", subtype: "success", result: text, total_cost_usd: cost, session_id: "x" } as unknown as SDKMessage);
  await waitFor(() => r.turnsEnded() > before);
}

/** Calls a master's tool the way the model does, through the real in-process tool server of the session. */
const callers = new Map<Rig, Map<number, Awaited<ReturnType<typeof makeCaller>>>>();
async function officeFor(r: Rig, session = 0) {
  const byRig = callers.get(r) ?? new Map();
  callers.set(r, byRig);
  if (!byRig.has(session)) byRig.set(session, await makeCaller(r, session));
  return byRig.get(session) as Awaited<ReturnType<typeof makeCaller>>;
}

async function makeCaller(r: Rig, session: number) {
  const server = r.calls[session]?.mcpServers?.[OFFICE_SERVER] as { instance: { connect(t: unknown): Promise<void> } } | undefined;
  assert.ok(server, "the session got the office tool server");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  clients.push(client);
  return async (name: string, args: object = {}) => {
    const res = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0]?.text ?? "";
    let data: unknown = null;
    if (!res.isError) data = JSON.parse(text);
    return { error: res.isError === true, text, data: data as Record<string, unknown> };
  };
}

describe("the master session", () => {
  it("is a master in the list, has exactly the worker tools plus the six office tools, and keeps the lockdown", async () => {
    const r = rig();
    const id = await startMaster(r);
    assert.equal(r.registry.get(id)?.role, "master");
    assert.equal(r.registry.get(id)?.parentId, null);
    const o = r.calls[0] as Options;
    const expected = [...WORKER_TOOLS, ...OFFICE_TOOL_NAMES];
    assert.deepEqual(OFFICE_TOOL_NAMES, ["spawn_worker", "assign_task", "wait_for_workers", "stop_worker", "list_workers", "submit_plan"].map((n) => `mcp__office__${n}`));
    assert.deepEqual(o.tools, expected);
    assert.deepEqual(o.allowedTools, expected);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(Object.keys(o.mcpServers ?? {}), [OFFICE_SERVER]);
    assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: `${MASTER_SYSTEM_PROMPT}

${PLAN_FIRST_PROMPT}` });
    for (const key of ["permissionMode", "settingSources", "disallowedTools", "maxBudgetUsd"] as const) {
      assert.deepEqual(o[key], lockdownOptions()[key], key);
    }
    assert.equal(o.maxTurns, MASTER_MAX_TURNS, "a master gets more turns than a worker");
    assert.ok(MASTER_MAX_TURNS > MAX_TURNS);
    assert.equal(o.hooks?.PreToolUse?.[0]?.onFailure, "block");
    assert.ok(!("ANTHROPIC_API_KEY" in (o.env ?? {})));
    const tools = (await (await officeFor(r))("list_workers")).data;
    assert.deepEqual(tools, { workers: [] });
  });

  it("lets the folder guard pass the office tools for a master only", async () => {
    const r = rig();
    await startMaster(r);
    const name = OFFICE_TOOL_NAMES[0] as string;
    assert.deepEqual(await checkToolCall(r.work, name, {}), { ok: false, reason: "this tool is not available to workers" });
    assert.deepEqual(await checkToolCall(r.work, name, {}, OFFICE_TOOL_NAMES), { ok: true });
    // The same through the hook the master session was given.
    const hook = r.calls[0]?.hooks?.PreToolUse?.[0]?.hooks[0];
    const out = await hook?.({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {} } as never, undefined, { signal: new AbortController().signal });
    assert.deepEqual(out, {});
  });

  it("allows one running master at a time; a stopped one frees the place", async () => {
    const r = rig();
    const id = await startMaster(r);
    assert.deepEqual(await r.supervisor.startMaster({ cwd: r.work, prompt: "x" }), { ok: false, status: 409, code: "master_running" });
    assert.equal(r.calls.length, 1);
    await r.supervisor.stop(id);
    assert.equal((await r.supervisor.startMaster({ cwd: r.work, prompt: "x" })).ok, true);
  });
});

describe("spawn_worker (M1)", () => {
  it("returns the worker id at once, and the worker is a child of the master with no office tools", async () => {
    const r = rig();
    const masterId = await startMaster(r);
    const call = await officeFor(r);
    const res = await call("spawn_worker", { name: "Researcher", folder: r.sub, task: "look around" });
    assert.equal(res.error, false);
    const workerId = res.data["id"] as string;
    const agent = r.registry.get(workerId);
    assert.deepEqual([agent?.role, agent?.parentId, agent?.name], ["worker", masterId, "Researcher"]);
    assert.equal(((await call("list_workers")).data["workers"] as { state: string }[])[0]?.state, "working");
    await waitFor(() => r.sessions[1]?.prompts.length === 1);
    assert.equal(r.sessions[1]?.prompts[0]?.message.content, "look around");
    // M7: the worker's options are the plain lockdown.
    const o = r.calls[1] as Options;
    for (const [key, value] of Object.entries(lockdownOptions())) assert.deepEqual(o[key as keyof Options], value, key);
    assert.ok(!("mcpServers" in o) && !("systemPrompt" in o));
    assert.ok(![...(o.tools as string[]), ...(o.allowedTools ?? [])].some((t) => t.startsWith("mcp__")));
    assert.equal(o.hooks?.PreToolUse?.[0]?.onFailure, "block");
    assert.ok(!("ANTHROPIC_API_KEY" in (o.env ?? {})));
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
    const denied = await hook?.({ hook_event_name: "PreToolUse", tool_name: OFFICE_TOOL_NAMES[0], tool_input: {} } as never, undefined, { signal: new AbortController().signal });
    assert.equal((denied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, "deny", "a worker is denied the office tools");
  });

  it("accepts a folder inside the master's folder, also given relative to it", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    assert.equal((await call("spawn_worker", { name: "A", folder: r.work, task: "t" })).error, false);
    assert.equal((await call("spawn_worker", { name: "B", folder: "sub", task: "t" })).error, false);
    assert.equal(r.calls.length, 3);
  });

  it("refuses folders outside the roots, outside the master's folder, parent references and links out, without a session and without a path in the answer", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    const outsideRoots = dir("elsewhere-");
    symlinkSync(r.sibling, join(r.sub, "link"), "junction"); // looks inside the master's folder, leads out of it
    const cases = [outsideRoots, r.sibling, r.root, "..", "../sibling", join(r.sub, "link"), "link", join(r.root, "missing")];
    for (const folder of cases) {
      const res = await call("spawn_worker", { name: "X", folder, task: "t" });
      assert.equal(res.error, true, folder);
      assert.ok(!res.text.includes(r.root) && !res.text.includes(outsideRoots), "no path in the answer");
    }
    assert.equal(r.calls.length, 1, "no session was created");
    assert.equal(r.registry.size(), 1);
  });

  it("rejects malformed arguments before they reach the supervisor", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    for (const args of [{ name: "", folder: r.sub, task: "t" }, { name: "A", folder: r.sub, task: "" }, { name: "A", folder: r.sub }, { name: "A", folder: "x".repeat(1001), task: "t" }, { name: 5, folder: r.sub, task: "t" }]) {
      assert.equal((await call("spawn_worker", args)).error, true, JSON.stringify(args).slice(0, 60));
    }
    assert.equal(r.calls.length, 1);
  });
});

describe("limits (M5, M6)", () => {
  it("stops spawning at 5 workers per master and counts only live ones", async () => {
    const r = rig({}, { maxManaged: 20 });
    await startMaster(r);
    const call = await officeFor(r);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call("spawn_worker", { name: `W${i}`, folder: r.sub, task: "t" })).data["id"] as string);
    const sixth = await call("spawn_worker", { name: "W5", folder: r.sub, task: "t" });
    assert.equal(sixth.error, true);
    assert.match(sixth.text, /5 running workers/);
    assert.equal(r.calls.length, 6);
    await call("stop_worker", { id: ids[0] });
    assert.equal((await call("spawn_worker", { name: "W6", folder: r.sub, task: "t" })).error, false);
  });

  it("returns an error at MAX_MANAGED and creates no session; an idle worker keeps its slot until stopped", async () => {
    const r = rig({}, { maxManaged: 3 });
    await startMaster(r); // slot 1
    const call = await officeFor(r);
    const a = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string; // slot 2
    await call("spawn_worker", { name: "B", folder: r.sub, task: "t" }); // slot 3
    await finishTurn(r, 1); // A is idle now
    const refused = await call("spawn_worker", { name: "C", folder: r.sub, task: "t" });
    assert.equal(refused.error, true);
    assert.match(refused.text, /Too many/);
    assert.equal(r.calls.length, 3, "no session for the refused spawn");
    await call("stop_worker", { id: a });
    assert.equal((await call("spawn_worker", { name: "C", folder: r.sub, task: "t" })).error, false);
  });

  it("counts the master's and the workers' cost together; a worker crossing the app cap blocks every further start and task", async () => {
    const r = rig({}, { totalBudgetUsd: 3 });
    await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    await finishTurn(r, 0, "plan", 1.9);
    await finishTurn(r, 1, "done", 1.9); // together 3.8
    await waitFor(() => r.registry.get(w)?.status === "stopped");
    assert.match(r.registry.get(w)?.note ?? "", /server run/);
    const spawn = await call("spawn_worker", { name: "B", folder: r.sub, task: "t" });
    assert.deepEqual([spawn.error, spawn.text], [true, "The usage cap was reached."]);
    assert.equal(r.calls.length, 2);
  });

  it("takes the workers with a master that reaches a cap", async () => {
    const r = rig();
    const m = await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    r.sessions[0]?.out.push({ type: "result", subtype: "success", result: "x", total_cost_usd: 2, session_id: "x" } as unknown as SDKMessage); // per-run cap
    await waitFor(() => r.registry.get(m)?.status === "stopped");
    await waitFor(() => r.registry.get(w)?.status === "stopped");
  });
});

describe("assign_task (M2)", () => {
  it("returns at once, passes the prompt on, and answers busy, stopped and not-yours like the page", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "first" })).data["id"] as string;
    const busy = await call("assign_task", { id: w, task: "too soon" });
    assert.deepEqual([busy.error, busy.text], [true, "That worker is still busy. Wait for it to finish."]);
    await finishTurn(r, 1);
    const ok = await call("assign_task", { id: w, task: "second" });
    assert.deepEqual([ok.error, ok.data["id"]], [false, w]);
    await waitFor(() => r.sessions[1]?.prompts.length === 2);
    assert.equal(r.sessions[1]?.prompts[1]?.message.content, "second");
    await call("stop_worker", { id: w });
    const stopped = await call("assign_task", { id: w, task: "late" });
    assert.deepEqual([stopped.error, stopped.text], [true, "That worker has stopped."]);
    const nobody = await call("assign_task", { id: "nobody", task: "x" });
    assert.match(nobody.text, /Not yours/);
  });
});

describe("wait_for_workers (M3)", () => {
  it("returns as soon as the workers are idle, with each last result at most 2000 characters long", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    const a = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    const b = (await call("spawn_worker", { name: "B", folder: r.sub, task: "t" })).data["id"] as string;
    const waiting = call("wait_for_workers", { timeout_s: 30 });
    await new Promise((r2) => setTimeout(r2, 50));
    await finishTurn(r, 1, "A".repeat(5000));
    await finishTurn(r, 2, "short answer");
    const res = await waiting;
    assert.equal(res.data["still_working"], false);
    const rows = res.data["workers"] as { id: string; state: string; result: string }[];
    assert.deepEqual(rows.map((x) => [x.id, x.state]), [[a, "idle"], [b, "idle"]]);
    assert.equal(rows[0]?.result.length, 2000);
    assert.equal(rows[1]?.result, "short answer");
  });

  it("says still working at the timeout, and the master can ask again", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    const a = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    const started = Date.now();
    const res = await call("wait_for_workers", { ids: [a], timeout_s: 1 });
    assert.ok(Date.now() - started >= 900);
    assert.equal(res.data["still_working"], true);
    assert.deepEqual((res.data["workers"] as { state: string; result?: string }[])[0], { id: a, name: "A", state: "working" });
    await finishTurn(r, 1, "now done");
    assert.equal((await call("wait_for_workers", { ids: [a], timeout_s: 1 })).data["still_working"], false);
  });

  it("refuses a wait longer than 120 seconds", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    await call("spawn_worker", { name: "A", folder: r.sub, task: "t" });
    for (const timeout_s of [121, 100_000, 0, 1.5, "60"]) assert.equal((await call("wait_for_workers", { timeout_s })).error, true, String(timeout_s));
  });

  it("is woken when the master itself is stopped, and returns at once with no workers", async () => {
    const r = rig();
    const m = await startMaster(r);
    const call = await officeFor(r);
    assert.deepEqual((await call("wait_for_workers", { timeout_s: 5 })).data, { still_working: false, workers: [] });
    await call("spawn_worker", { name: "A", folder: r.sub, task: "t" });
    const waiting = call("wait_for_workers", { timeout_s: 100 });
    await new Promise((r2) => setTimeout(r2, 30));
    await r.supervisor.stop(m);
    await waiting; // does not hang for 100 seconds
  });

  it("keeps results in memory only", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    await call("spawn_worker", { name: "A", folder: r.sub, task: "t" });
    await finishTurn(r, 1, "RESULT-TEXT-123");
    await r.supervisor.settled();
    const file = readFileSync(join(r.dataDir, STORE_FILE), "utf8");
    assert.ok(!file.includes("RESULT-TEXT-123") && !JSON.stringify(r.logs).includes("RESULT-TEXT-123"));
  });
});

describe("ownership (M4)", () => {
  it("lets a master see and change only its own workers", async () => {
    const r = rig({}, { maxMasters: 2 });
    await startMaster(r);
    await startMaster(r);
    const mine = await officeFor(r, 0);
    const theirs = await officeFor(r, 1);
    const a = (await mine("spawn_worker", { name: "Mine", folder: r.sub, task: "t" })).data["id"] as string; // session 2
    const b = (await theirs("spawn_worker", { name: "Theirs", folder: r.sub, task: "t" })).data["id"] as string; // session 3
    await finishTurn(r, 3);

    assert.deepEqual(((await mine("list_workers")).data["workers"] as { id: string }[]).map((x) => x.id), [a]);
    assert.deepEqual(((await theirs("list_workers")).data["workers"] as { id: string }[]).map((x) => x.id), [b]);
    for (const [tool, args] of [["assign_task", { id: b, task: "hijack" }], ["stop_worker", { id: b }], ["wait_for_workers", { ids: [b], timeout_s: 1 }]] as const) {
      const res = await mine(tool, args);
      assert.deepEqual([tool, res.error, /Not yours/.test(res.text)], [tool, true, true]);
    }
    assert.notEqual(r.registry.get(b)?.status, "stopped", "the other worker was not stopped");
    assert.equal(r.sessions[3]?.interrupts, 0);
    assert.equal(r.sessions[3]?.prompts.length, 1, "and got no task");
    assert.equal(r.supervisor.liveCount(), 4);
  });

  it("says not yours for another master, the master itself and an observed session, and changes nothing", async () => {
    const r = rig({}, { maxMasters: 2 });
    const m1 = await startMaster(r);
    const m2 = { ok: true as const, id: await startMaster(r) };
    r.registry.upsert("observed-1", { kind: "session", origin: "observed", parentId: null, project: "p", name: "n", currentTask: null });
    const call = await officeFor(r, 0);
    for (const id of [m2.id, m1, "observed-1", "unknown"]) {
      for (const [tool, args] of [["stop_worker", { id }], ["assign_task", { id, task: "x" }]] as const) {
        const res = await call(tool, args);
        assert.deepEqual([id, tool, res.error, /Not yours/.test(res.text)], [id, tool, true, true]);
      }
    }
    assert.equal(r.supervisor.liveCount(), 2);
    assert.equal(r.registry.get("observed-1")?.status, "idle");
    assert.equal(r.sessions[1]?.interrupts, 0);
    assert.equal(r.sessions[0]?.interrupts, 0);
  });

  it("rejects ids that do not match the strict pattern", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    for (const id of ["../x", "a b", "", "x".repeat(101), 5]) {
      assert.equal((await call("stop_worker", { id })).error, true, String(id));
      assert.equal((await call("assign_task", { id, task: "x" })).error, true, String(id));
    }
  });
});

describe("stopping (M6, M10)", () => {
  it("stop_worker ends one worker and leaves the master running", async () => {
    const r = rig();
    const m = await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    const res = await call("stop_worker", { id: w });
    assert.deepEqual(res.data, { id: w, state: "stopped" });
    assert.equal(r.registry.get(w)?.status, "stopped");
    assert.notEqual(r.registry.get(m)?.status, "stopped");
  });

  it("stops every worker when the master is stopped from the page", async () => {
    const r = rig({ spawnChild: true });
    const m = await startMaster(r);
    const call = await officeFor(r);
    const ws = [] as string[];
    for (let i = 0; i < 3; i++) ws.push((await call("spawn_worker", { name: `W${i}`, folder: r.sub, task: "t" })).data["id"] as string);
    await r.supervisor.stop(m);
    await waitFor(() => ws.every((w) => r.registry.get(w)?.status === "stopped"));
    assert.equal(r.supervisor.liveCount(), 0);
    assert.ok(r.sessions.every((s) => s.interrupts >= 1 || s.aborted), "each session was told to end");
  });

  it("stops every worker when the master dies", async () => {
    const r = rig();
    const m = await startMaster(r);
    const call = await officeFor(r);
    const ws = [(await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string, (await call("spawn_worker", { name: "B", folder: r.sub, task: "t" })).data["id"] as string];
    r.sessions[0]?.out.close(); // the master's stream ends by itself
    await waitFor(() => r.registry.get(m)?.status === "stopped");
    await waitFor(() => ws.every((w) => r.registry.get(w)?.status === "stopped"));
    assert.equal(r.supervisor.liveCount(), 0);
  });

  it("lists master and workers as detached after a restart, without starting anything", async () => {
    const r = rig();
    const m = await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    await r.supervisor.settled();
    assert.equal((await loadStore(r.dataDir)).length, 2);
    const registry = createRegistry();
    const again = createSupervisor({ registry, query: r.query, roots: [r.root], env: {}, dataDir: r.dataDir, log: () => {} });
    supervisors.push(again);
    await again.recover();
    assert.deepEqual([m, w].map((id) => registry.get(id)?.status), ["detached", "detached"]);
    assert.equal(again.liveCount(), 0);
    assert.equal(r.calls.length, 2, "nothing was started");
  });

  it("keeps a worker under its master after a restart, and dismissing the master clears them both", async () => {
    const r = rig();
    const m = await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "t" })).data["id"] as string;
    await r.supervisor.settled();
    const registry = createRegistry();
    const again = createSupervisor({ registry, query: r.query, roots: [r.root], env: {}, dataDir: r.dataDir, log: () => {} });
    supervisors.push(again);
    await again.recover();
    assert.equal(registry.get(w)?.parentId, m);
    await again.stop(m);
    assert.deepEqual([registry.get(m), registry.get(w)], [undefined, undefined]);
    await again.settled();
    assert.equal((await loadStore(r.dataDir)).length, 0);
  });
});

describe("list_workers", () => {
  it("shows state, task and result, and no folder path", async () => {
    const r = rig();
    await startMaster(r);
    const call = await officeFor(r);
    const w = (await call("spawn_worker", { name: "A", folder: r.sub, task: "count the files" })).data["id"] as string;
    await finishTurn(r, 1, "42 files");
    const res = await call("list_workers");
    assert.deepEqual(res.data["workers"], [{ id: w, name: "A", state: "idle", result: "42 files", task: "count the files" }]);
    assert.ok(!res.text.includes(r.root));
  });
});
