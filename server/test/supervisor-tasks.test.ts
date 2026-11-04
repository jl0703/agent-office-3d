import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { lockdownOptions } from "../src/lockdown.ts";
import { loadStore, saveStore, STORE_FILE, type StoredWorker } from "../src/managedStore.ts";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor, DEFAULT_RESUME_PROMPT, type SupervisorOptions } from "../src/supervisor.ts";
import { createFake, initMessage, rateLimitedReply, rateLimitMessage, resultMessage, storedWorker, type FakeOptions } from "./fakeQuery.ts";

const made: string[] = [];
const supervisors: ReturnType<typeof createSupervisor>[] = [];
after(async () => {
  await Promise.all(supervisors.map((s) => s.close()));
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const dir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

function rig(fake: FakeOptions = {}, extra: Partial<SupervisorOptions> = {}) {
  const root = dir("tasks-");
  const work = join(root, "demo");
  mkdirSync(work);
  const dataDir = join(root, "data");
  const projectsDir = join(root, "projects");
  mkdirSync(projectsDir);
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
    projectsDir,
    log: (l) => logs.push(l),
    ...extra,
  });
  supervisors.push(supervisor);
  const stored = (id: string, over: Partial<StoredWorker> = {}) => storedWorker(id, { cwd: work, ...over });
  /** Puts workers in the file and starts the supervisor up on it, like a restart. */
  const restartWith = async (...workers: StoredWorker[]) => {
    await supervisor.settled(); // writes still queued would overwrite the file
    await saveStore(dataDir, workers);
    await supervisor.recover();
  };
  const readFile = () => loadStore(dataDir);
  const turnsEnded = () => logs.filter((l) => l["event"] === "managed-turn-end").length;
  return { root, work, dataDir, projectsDir, registry, logs, supervisor, stored, restartWith, readFile, turnsEnded, ...f };
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

async function startOne(r: Rig, prompt = "go") {
  const res = await r.supervisor.start({ cwd: r.work, prompt });
  assert.ok(res.ok);
  return res.id;
}
/** Ends the worker's current turn, so it is idle. */
async function finishTurn(r: Rig, session = 0, cost = 0.1) {
  const before = r.turnsEnded();
  r.sessions[session]?.out.push(resultMessage(cost));
  await waitFor(() => r.turnsEnded() > before);
}

describe("giving a worker a task", () => {
  it("accepts a task for an idle worker and passes the prompt on", async () => {
    const r = rig();
    const id = await startOne(r);
    await finishTurn(r);
    assert.deepEqual(r.supervisor.assign(id, "  second   job "), { ok: true });
    await waitFor(() => r.sessions[0]?.prompts.length === 2);
    assert.equal(r.sessions[0]?.prompts[1]?.message.content, "  second   job ");
    assert.equal(r.registry.get(id)?.currentTask, "second job");
    assert.equal(r.registry.get(id)?.status, "working");
  });

  it("answers busy while a task is in progress, and again once the next task has begun", async () => {
    const r = rig();
    const id = await startOne(r);
    assert.deepEqual(r.supervisor.assign(id, "too soon"), { ok: false, status: 409, code: "busy" });
    await finishTurn(r);
    assert.equal(r.supervisor.assign(id, "one").ok, true);
    assert.deepEqual(r.supervisor.assign(id, "two"), { ok: false, status: 409, code: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(r.sessions[0]?.prompts.length, 2, "only the first extra task reached the session");
  });

  it("refuses a stopped worker, a detached worker and an unknown one, each with its own reason", async () => {
    const r = rig();
    const id = await startOne(r);
    await r.supervisor.stop(id);
    assert.deepEqual(r.supervisor.assign(id, "x"), { ok: false, status: 409, code: "stopped" });
    await r.restartWith(r.stored("old-one"));
    assert.deepEqual(r.supervisor.assign("old-one", "x"), { ok: false, status: 409, code: "detached" });
    assert.deepEqual(r.supervisor.assign("nope", "x"), { ok: false, status: 404, code: "not_found" });
    assert.equal(r.calls.length, 1, "nothing new reached the SDK");
  });
});

describe("usage caps", () => {
  it("stops a worker whose run reaches the per-run cap, and says why", async () => {
    const r = rig();
    const id = await startOne(r);
    r.sessions[0]?.out.push(resultMessage(2));
    await waitFor(() => r.registry.get(id)?.status === "stopped");
    assert.match(r.registry.get(id)?.note ?? "", /one run/);
    assert.deepEqual(r.supervisor.assign(id, "more"), { ok: false, status: 409, code: "stopped" });
    assert.ok(r.logs.some((l) => l["event"] === "managed-cap" && l["cap"] === "run"));
  });

  it("treats the SDK's own budget stop as the per-run cap", async () => {
    const r = rig();
    const id = await startOne(r);
    r.sessions[0]?.out.push(resultMessage(0.4, "error_max_budget_usd"));
    await waitFor(() => r.registry.get(id)?.status === "stopped");
    assert.match(r.registry.get(id)?.note ?? "", /one run/);
  });

  it("adds up a session across resumes, stops it at the session cap, and refuses the next resume", async () => {
    const r = rig({ sessionId: () => "sess" }, { sessionBudgetUsd: 3 });
    const id = await startOne(r);
    await finishTurn(r, 0, 1.5);
    await r.supervisor.stop(id);
    assert.deepEqual(await r.supervisor.resume(id), { ok: true });
    r.sessions[1]?.out.push(resultMessage(1.6)); // alone under every cap, but 3.1 with the first run
    await waitFor(() => r.registry.get(id)?.status === "stopped");
    assert.match(r.registry.get(id)?.note ?? "", /this session/);
    assert.deepEqual(await r.supervisor.resume(id), { ok: false, status: 429, code: "budget" });
    assert.equal(r.calls.length, 2, "the refused resume never reached the SDK");
    await r.supervisor.settled();
    assert.ok(Math.abs(((await r.readFile())[0]?.costUsdTotal ?? 0) - 3.1) < 1e-9, "the total is kept in the file");
  });

  it("stops at the app cap and refuses the next start, assign and resume", async () => {
    const r = rig({}, { totalBudgetUsd: 3 });
    const a = await startOne(r);
    const b = await startOne(r);
    await finishTurn(r, 0, 1.9);
    await finishTurn(r, 1, 1.9); // together 3.8
    await waitFor(() => r.registry.get(b)?.status === "stopped");
    assert.match(r.registry.get(b)?.note ?? "", /server run/);
    assert.deepEqual(r.supervisor.assign(a, "more"), { ok: false, status: 429, code: "budget" });
    assert.deepEqual(await r.supervisor.start({ cwd: r.work, prompt: "new" }), { ok: false, status: 429, code: "budget" });
    assert.deepEqual(await r.supervisor.resume(b), { ok: false, status: 429, code: "budget" });
    assert.equal(r.calls.length, 2);
  });

  it("counts a cost only once when later results repeat the run's total", async () => {
    const r = rig({}, { totalBudgetUsd: 3 });
    const id = await startOne(r);
    await finishTurn(r, 0, 1.5);
    r.supervisor.assign(id, "again");
    await finishTurn(r, 0, 1.5); // the same total again: nothing new was spent
    await finishTurn(r, 0, 1.5);
    assert.equal(r.registry.get(id)?.status, "working");
    assert.equal(r.supervisor.assign(id, "still fine").ok, true);
  });
});

describe("usage limit of the subscription", () => {
  it("shows waiting with a note and the reset time, keeps the session open, and retries nothing", async () => {
    const r = rig();
    const id = await startOne(r);
    r.sessions[0]?.out.push(rateLimitMessage("rejected", 1_800_000_000));
    await waitFor(() => r.registry.get(id)?.status === "waiting");
    assert.match(r.registry.get(id)?.note ?? "", /Usage limit reached\. Resets around 2027-01-15 08:00 UTC/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(r.calls.length, 1);
    assert.equal(r.sessions[0]?.prompts.length, 1, "nothing was sent again");
    assert.equal(r.supervisor.liveCount(), 1, "the session stays open");
  });

  it("also pauses when a reply carries the rate-limit error, and ignores warnings", async () => {
    const r = rig();
    const warned = await startOne(r);
    r.sessions[0]?.out.push(rateLimitMessage("allowed_warning"));
    r.sessions[0]?.out.push(initMessage(warned)); // a later message, so the warning has been handled
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.notEqual(r.registry.get(warned)?.status, "waiting");
    const replied = await startOne(r);
    r.sessions[1]?.out.push(rateLimitedReply());
    await waitFor(() => r.registry.get(replied)?.status === "waiting");
  });

  it("clears the waiting state when the worker is given a new task", async () => {
    const r = rig();
    const id = await startOne(r);
    r.sessions[0]?.out.push(rateLimitMessage("rejected"));
    await waitFor(() => r.registry.get(id)?.status === "waiting");
    assert.deepEqual(r.supervisor.assign(id, "try again"), { ok: true });
    assert.equal(r.registry.get(id)?.status, "working");
    assert.equal(r.registry.get(id)?.note, null);
    await waitFor(() => r.sessions[0]?.prompts.length === 2);
  });
});

describe("the worker file", () => {
  it("is written after a start and each result, keeps costs, and holds no prompt, path secret or environment value", async () => {
    const r = rig({}, {});
    const id = await startOne(r, `${"a".repeat(250)}SECRET-PROMPT-TAIL`);
    await waitFor(async () => (await r.readFile()).length === 1);
    r.sessions[0]?.out.push(resultMessage(0.75));
    await waitFor(async () => (await r.readFile())[0]?.costUsdTotal === 0.75);
    const text = readFileSync(join(r.dataDir, STORE_FILE), "utf8");
    assert.ok(!text.includes("SECRET-PROMPT-TAIL") && !text.includes("secret-key"));
    const [worker] = await r.readFile();
    assert.equal(worker?.id, id);
    assert.equal(worker?.task.length, 200);
    assert.equal(worker?.project, "demo");
  });

  it("records the process, and drops it once the worker has ended", async () => {
    const r = rig({ spawnChild: true }, { inspect: async () => ({ name: "node", startedAtMs: 1234 }) });
    await startOne(r);
    const pid = r.sessions[0]?.childPid;
    assert.ok(pid);
    await waitFor(async () => (await r.readFile())[0]?.pid === pid);
    assert.deepEqual(
      (await r.readFile()).map((w) => [w.processName, w.pidStartedAt]),
      [["node", 1234]],
    );
    await r.supervisor.stopAll();
    await waitFor(async () => (await r.readFile())[0]?.pid === null);
  });
});

describe("recovery after a restart", () => {
  it("lists stored workers as detached with a note, and never calls the SDK", async () => {
    const r = rig();
    await r.restartWith(r.stored("w-1", { name: "First" }), r.stored("w-2"));
    assert.equal(r.calls.length, 0, "nothing was started");
    assert.equal(r.supervisor.liveCount(), 0);
    for (const id of ["w-1", "w-2"]) {
      const agent = r.registry.get(id);
      assert.equal(agent?.status, "detached");
      assert.equal(agent?.origin, "managed");
      assert.match(agent?.note ?? "", /Detached/);
      assert.equal(r.supervisor.claims(id), true, "the log watcher leaves it alone");
    }
    assert.equal(r.registry.get("w-1")?.name, "First");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(r.calls.length, 0, "and nothing starts later either");
  });

  it("stops only leftover processes whose name and start time match, then forgets the process", async () => {
    const killed: number[] = [];
    const r = rig(
      {},
      {
        inspect: async (pid) => ({ name: "node", startedAtMs: pid === 4242 ? 5000 : 9_999_999 }),
        killTree: async (pid) => void killed.push(pid),
      },
    );
    await r.restartWith(
      r.stored("match", { pid: 4242, processName: "node", pidStartedAt: 5000 }),
      r.stored("reused", { pid: 4343, processName: "node", pidStartedAt: 5000 }),
      r.stored("renamed", { pid: 4242, processName: "other", pidStartedAt: 5000 }),
    );
    assert.deepEqual(killed, [4242]);
    await waitFor(async () => (await r.readFile()).every((w) => w.pid === null));
    assert.ok(r.logs.some((l) => l["event"] === "managed-recovered" && l["killed"] === 1 && l["workers"] === 3));
  });

  it("stops a matching leftover process even when its entry is older than 24 hours, then forgets the entry", async () => {
    const killed: number[] = [];
    const r = rig({}, { inspect: async () => ({ name: "node", startedAtMs: 5000 }), killTree: async (pid) => void killed.push(pid) });
    await r.restartWith(r.stored("ancient", { pid: 4242, processName: "node", pidStartedAt: 5000, updatedAt: Date.now() - 25 * 3_600_000 }));
    assert.deepEqual(killed, [4242]);
    assert.equal(r.registry.has("ancient"), false);
    await r.supervisor.settled();
    assert.equal((await r.readFile()).length, 0);
  });

  it("starts empty, and sets the file aside, when it is damaged", async () => {
    const r = rig();
    mkdirSync(r.dataDir);
    writeFileSync(join(r.dataDir, STORE_FILE), '{"version":1,"workers":[{"id":"x; calc","cwd":"x"}]}');
    await r.supervisor.recover();
    assert.equal(r.registry.size(), 0);
    assert.equal(r.calls.length, 0);
    assert.ok(readFileSync(join(r.dataDir, `${STORE_FILE}.bad`), "utf8").includes("calc"));
  });

  it("does nothing without a data folder", async () => {
    const r = rig({}, { dataDir: undefined as never });
    await r.supervisor.recover();
    assert.equal(r.registry.size(), 0);
  });
});

describe("resuming", () => {
  it("continues a detached worker under the same id, with every protection of a normal start", async () => {
    const r = rig({ sessionId: () => "old-one" });
    await r.restartWith(r.stored("old-one", { costUsdTotal: 1 }));
    assert.deepEqual(await r.supervisor.resume("old-one"), { ok: true });
    const o = r.calls[0];
    assert.ok(o);
    assert.equal(o.resume, "old-one");
    for (const [key, value] of Object.entries(lockdownOptions())) assert.deepEqual(o[key as keyof typeof o], value, key);
    assert.equal(o.hooks?.PreToolUse?.[0]?.onFailure, "block");
    assert.ok(o.cwd?.toLowerCase().endsWith("demo"));
    assert.ok(!("ANTHROPIC_API_KEY" in (o.env ?? {})), "the API key is not passed on");
    await waitFor(() => r.sessions[0]?.prompts.length === 1);
    assert.equal(r.sessions[0]?.prompts[0]?.message.content, DEFAULT_RESUME_PROMPT);
    const agent = r.registry.get("old-one");
    assert.equal(agent?.status, "working");
    assert.equal(agent?.note, null);
    assert.equal(r.registry.size(), 1, "same entry, not a new one");
    assert.equal(r.supervisor.liveCount(), 1);
  });

  it("sends the message it was given, and can be resumed again after being stopped", async () => {
    const r = rig({ sessionId: () => "sess" });
    const id = await startOne(r);
    await r.supervisor.stop(id);
    assert.deepEqual(await r.supervisor.resume(id, "Carry on with part two"), { ok: true });
    await waitFor(() => r.sessions[1]?.prompts.length === 1);
    assert.equal(r.sessions[1]?.prompts[0]?.message.content, "Carry on with part two");
    assert.equal(r.registry.get(id)?.status, "working");
    assert.equal(r.registry.get(id)?.currentTask, "Carry on with part two");
    assert.equal(r.registry.size(), 1);
    await finishTurn(r, 1);
    assert.equal(r.supervisor.assign(id, "and a task").ok, true, "a resumed worker takes tasks");
  });

  it("refuses a worker that is still running, and a second resume that arrives at the same moment", async () => {
    const r = rig({ sessionId: () => "sess" });
    const live = await startOne(r);
    assert.deepEqual(await r.supervisor.resume(live), { ok: false, status: 409, code: "not_resumable" });
    assert.deepEqual(await r.supervisor.resume("unknown"), { ok: false, status: 404, code: "not_found" });
    await r.supervisor.stop(live);
    const results = await Promise.all([r.supervisor.resume(live), r.supervisor.resume(live)]);
    assert.deepEqual(results.map((x) => x.ok).sort(), [false, true]);
    assert.equal(r.calls.length, 2, "only one resume reached the SDK");
  });

  it("refuses a folder that is no longer allowed or gone, without starting anything", async () => {
    const r = rig();
    const elsewhere = dir("elsewhere-");
    await r.restartWith(r.stored("outside", { cwd: elsewhere }), r.stored("missing", { cwd: join(r.root, "deleted") }));
    assert.deepEqual(await r.supervisor.resume("outside"), { ok: false, status: 403, code: "folder_not_allowed" });
    assert.deepEqual(await r.supervisor.resume("missing"), { ok: false, status: 400, code: "invalid_folder" });
    assert.equal(r.calls.length, 0);
    assert.equal(r.registry.get("outside")?.status, "detached");
  });

  it("refuses while the transcript was written to in the last 10 seconds, and goes ahead when it is quiet", async () => {
    const r = rig({ sessionId: () => "busy-one" });
    await r.restartWith(r.stored("busy-one"));
    mkdirSync(join(r.projectsDir, "some-project"));
    const log = join(r.projectsDir, "some-project", "busy-one.jsonl");
    writeFileSync(log, "{}\n");
    assert.deepEqual(await r.supervisor.resume("busy-one"), { ok: false, status: 409, code: "transcript_active" });
    assert.equal(r.calls.length, 0);
    const old = new Date(Date.now() - 60_000);
    utimesSync(log, old, old);
    assert.deepEqual(await r.supervisor.resume("busy-one"), { ok: true });
  });

  it("refuses when the budget is used up", async () => {
    const r = rig({}, { sessionBudgetUsd: 3 });
    await r.restartWith(r.stored("spent", { costUsdTotal: 3 }));
    assert.deepEqual(await r.supervisor.resume("spent"), { ok: false, status: 429, code: "budget" });
    assert.equal(r.calls.length, 0);
  });

  it("respects the limit of live workers", async () => {
    const r = rig({}, { maxManaged: 1 });
    await startOne(r);
    await r.restartWith(r.stored("old-one"));
    assert.deepEqual(await r.supervisor.resume("old-one"), { ok: false, status: 429, code: "too_many" });
  });

  it("fails and stays detached when the session reports another id, or is not on the subscription login", async () => {
    const other = rig({ sessionId: () => "somebody-else" });
    await other.restartWith(other.stored("mine"));
    assert.deepEqual(await other.supervisor.resume("mine"), { ok: false, status: 502, code: "start_failed" });
    assert.equal(other.registry.get("mine")?.status, "detached");
    assert.equal(other.registry.has("somebody-else"), false);
    assert.equal(other.supervisor.liveCount(), 0);

    const keyed = rig({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: () => "mine" });
    await keyed.restartWith(keyed.stored("mine"));
    assert.deepEqual(await keyed.supervisor.resume("mine"), { ok: false, status: 502, code: "start_failed" });
    assert.equal(keyed.registry.get("mine")?.status, "detached");
  });

  it("never puts a prompt or a folder path in the logs", async () => {
    const r = rig({ sessionId: () => "sess" });
    const id = await startOne(r, "TOP-SECRET-PROMPT");
    await finishTurn(r);
    r.supervisor.assign(id, "TOP-SECRET-TASK");
    await r.supervisor.stop(id);
    await r.supervisor.resume(id, "TOP-SECRET-RESUME");
    const text = JSON.stringify(r.logs);
    assert.ok(!text.includes("TOP-SECRET") && !text.includes(basename(r.root)));
  });
});

describe("dismissing", () => {
  it("forgets a stopped worker and a detached worker, in the list and in the file", async () => {
    const r = rig();
    const id = await startOne(r);
    await r.restartWith(r.stored("old-one"));
    await r.supervisor.stop(id);
    assert.equal(r.registry.has(id), true, "stopped workers stay until dismissed");
    assert.equal(await r.supervisor.stop(id), "ok");
    assert.equal(await r.supervisor.stop("old-one"), "ok");
    for (const gone of [id, "old-one"]) {
      assert.equal(r.registry.has(gone), false);
      assert.equal(r.supervisor.claims(gone), false);
    }
    await waitFor(async () => (await r.readFile()).length === 0);
    assert.equal(await r.supervisor.stop(id), "not_found");
  });
});
