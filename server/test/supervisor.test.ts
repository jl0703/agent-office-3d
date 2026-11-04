import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ServerEvent } from "../../shared/events.ts";
import { lockdownOptions } from "../src/lockdown.ts";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor, type SupervisorOptions } from "../src/supervisor.ts";
import { createFake, initMessage, toolMessage, type FakeOptions } from "./fakeQuery.ts";

const made: string[] = [];
const supervisors: ReturnType<typeof createSupervisor>[] = [];
after(async () => {
  await Promise.all(supervisors.map((s) => s.close()));
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function rig(fake: FakeOptions = {}, extra: Partial<SupervisorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "managed-"));
  made.push(root);
  const work = join(root, "demo");
  mkdirSync(work);
  const registry = createRegistry();
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  const logs: Record<string, unknown>[] = [];
  const f = createFake(fake);
  const supervisor = createSupervisor({
    registry,
    query: f.query,
    roots: [root],
    env: { PATH: "p", ANTHROPIC_API_KEY: "secret-key" },
    stopGraceMs: 150,
    startTimeoutMs: 400,
    forgetAfterMs: 60_000,
    log: (l) => logs.push(l),
    ...extra,
  });
  supervisors.push(supervisor);
  return { root, work, registry, events, logs, supervisor, ...f };
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`condition not met within ${ms} ms`);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("supervisor: starting", () => {
  it("starts a worker, lists it as managed, and gives it the prompt", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "  fix   the\nbug  ", name: "Fixer" });
    assert.ok(res.ok);
    const agent = r.registry.get(res.id);
    assert.ok(agent);
    assert.equal(agent.origin, "managed");
    assert.equal(agent.role, "worker");
    assert.equal(agent.kind, "session");
    assert.equal(agent.name, "Fixer");
    assert.equal(agent.project, "demo");
    assert.equal(agent.currentTask, "fix the bug");
    await waitFor(() => r.sessions[0]?.prompts.length === 1);
    assert.equal(r.sessions[0]?.prompts[0]?.message.content, "fix   the\nbug".length ? "  fix   the\nbug  " : "");
  });

  it("starts the session locked down, in the real folder, with a cleaned environment", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "go" });
    assert.ok(res.ok);
    const o = r.calls[0];
    assert.ok(o);
    for (const [key, value] of Object.entries(lockdownOptions())) assert.deepEqual(o[key as keyof typeof o], value, key);
    assert.ok(o.cwd && o.cwd.toLowerCase().endsWith("demo"));
    assert.equal(o.env?.["PATH"], "p");
    assert.ok(!("ANTHROPIC_API_KEY" in (o.env ?? {})), "the API key is not passed on");
    assert.equal(o.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
    assert.ok(o.abortController instanceof AbortController);
  });

  it("puts a folder guard on every session, and the guard blocks anything outside the folder", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "go" });
    assert.ok(res.ok);
    const matcher = r.calls[0]?.hooks?.PreToolUse?.[0];
    assert.equal(matcher?.onFailure, "block", "a failing guard blocks the call");
    const hook = matcher?.hooks[0];
    assert.ok(hook);
    const run = (tool: string, input: object) =>
      hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal });
    assert.deepEqual(await run("Read", { file_path: join(r.work, "a.txt") }), {});
    const outside = (await run("Write", { file_path: join(r.root, "outside.txt") })) as { hookSpecificOutput: { permissionDecision: string } };
    assert.equal(outside.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(r.logs.some((l) => l["event"] === "managed-tool-denied" && l["tool"] === "Write"));
    assert.ok(!JSON.stringify(r.logs).includes("outside.txt"), "denials do not log the path");
  });

  it("refuses a folder outside the allowed roots, and a folder that does not exist, without starting anything", async () => {
    const r = rig();
    const outside = mkdtempSync(join(tmpdir(), "elsewhere-"));
    made.push(outside);
    assert.deepEqual(await r.supervisor.start({ cwd: outside, prompt: "x" }), { ok: false, status: 403, code: "folder_not_allowed" });
    assert.deepEqual(await r.supervisor.start({ cwd: join(r.root, "missing"), prompt: "x" }), { ok: false, status: 400, code: "invalid_folder" });
    assert.deepEqual(await r.supervisor.start({ cwd: "relative", prompt: "x" }), { ok: false, status: 400, code: "invalid_folder" });
    assert.equal(r.calls.length, 0);
    assert.equal(r.registry.size(), 0);
  });

  it("allows at most the limit, even when starts arrive at the same moment", async () => {
    const r = rig({ initDelayMs: 30 }, { maxManaged: 2 });
    const results = await Promise.all([1, 2, 3, 4].map(() => r.supervisor.start({ cwd: r.work, prompt: "x" })));
    assert.equal(results.filter((x) => x.ok).length, 2);
    assert.equal(results.filter((x) => !x.ok && x.status === 429).length, 2);
    assert.equal(r.calls.length, 2, "refused starts never reach the SDK");
    assert.equal(r.supervisor.liveCount(), 2);
  });

  it("frees a slot when a worker is stopped", async () => {
    const r = rig({}, { maxManaged: 1 });
    const first = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(first.ok);
    assert.equal((await r.supervisor.start({ cwd: r.work, prompt: "x" })).ok, false);
    await r.supervisor.stop(first.id);
    assert.equal((await r.supervisor.start({ cwd: r.work, prompt: "x" })).ok, true);
  });

  it("refuses a session that is not on the subscription login, and shows nothing for it", async () => {
    const r = rig({ apiKeySource: "ANTHROPIC_API_KEY" });
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.deepEqual(res, { ok: false, status: 502, code: "start_failed" });
    assert.equal(r.registry.size(), 0);
    assert.ok(r.logs.some((l) => l["event"] === "managed-refused" && l["reason"] === "api_key_source"));
    assert.equal(r.supervisor.liveCount(), 0);
  });

  it("checks the key source on every init message, not just the first", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    r.sessions[0]?.out.push(initMessage("session-1", "none")); // repeats are fine
    assert.equal(r.registry.size(), 1);
    r.sessions[0]?.out.push(initMessage("session-1", "apiKeyHelper"));
    await waitFor(() => r.registry.get(res.id)?.status === "error");
  });

  it("keeps its first session id when a later init message names another", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    r.sessions[0]?.out.push(initMessage("a-different-id", "none"));
    r.sessions[0]?.out.push(toolMessage("t1", "Read", { file_path: "z.ts" }));
    await waitFor(() => r.registry.get(res.id)?.activity === "Read z.ts");
    assert.equal(r.registry.size(), 1);
    assert.equal(r.supervisor.claims("a-different-id"), false);
  });

  it("fails cleanly when the session ends or never reports its id", async () => {
    const ended = rig({ endBeforeInit: true });
    assert.deepEqual(await ended.supervisor.start({ cwd: ended.work, prompt: "x" }), { ok: false, status: 502, code: "start_failed" });
    const silent = rig({ neverInit: true });
    assert.deepEqual(await silent.supervisor.start({ cwd: silent.work, prompt: "x" }), { ok: false, status: 502, code: "start_failed" });
    assert.equal(silent.registry.size(), 0);
    assert.equal(silent.supervisor.liveCount(), 0);
  });

  it("force-stops a session that is stuck before it reports its id", async () => {
    const r = rig({ neverInit: true, stubborn: true, spawnChild: true });
    assert.deepEqual(await r.supervisor.start({ cwd: r.work, prompt: "x" }), { ok: false, status: 502, code: "start_failed" });
    const pid = r.sessions[0]?.childPid;
    assert.equal(r.sessions[0]?.aborted, true);
    assert.ok(pid);
    await waitFor(() => !alive(pid), 5000);
    assert.equal(r.supervisor.liveCount(), 0);
    assert.equal(r.registry.size(), 0);
  });

  it("knows a start is under way, and owns the id afterwards", async () => {
    const r = rig({ initDelayMs: 100, sessionId: () => "owned-id" });
    assert.equal(r.supervisor.starting(), false);
    const pending = r.supervisor.start({ cwd: r.work, prompt: "x" });
    await waitFor(() => r.supervisor.starting());
    const res = await pending;
    assert.ok(res.ok);
    assert.equal(r.supervisor.starting(), false);
    assert.equal(r.supervisor.claims("owned-id"), true);
    assert.equal(r.supervisor.claims("someone-else"), false);
  });

  it("never logs the prompt or the name", async () => {
    const r = rig();
    await r.supervisor.start({ cwd: r.work, prompt: "TOP-SECRET-PROMPT", name: "TOP-SECRET-NAME" });
    await r.supervisor.stopAll();
    assert.ok(r.logs.length > 0);
    assert.ok(!JSON.stringify(r.logs).includes("TOP-SECRET"));
  });
});

describe("supervisor: watching a worker", () => {
  it("turns tool calls into activity, using only a short summary", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    r.sessions[0]?.out.push(toolMessage("t1", "Edit", { file_path: "C:\\p\\app.ts", new_string: "SECRET" }));
    await waitFor(() => r.registry.get(res.id)?.activity === "Edit app.ts");
    assert.equal(r.registry.get(res.id)?.status, "working");
    assert.ok(!JSON.stringify(r.events).includes("SECRET"));
  });

  it("marks a worker as errored when its stream fails", async () => {
    const r = rig({ throwAfterInit: true });
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    await waitFor(() => r.registry.get(res.id)?.status === "error");
    assert.equal(r.supervisor.liveCount(), 0);
  });
});

describe("supervisor: stopping", () => {
  it("stops a cooperative worker: interrupt, close the input, status stopped", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    assert.equal(await r.supervisor.stop(res.id), "ok");
    assert.equal(r.registry.get(res.id)?.status, "stopped");
    assert.equal(r.sessions[0]?.interrupts, 1);
    assert.equal(r.sessions[0]?.aborted, false, "no force was needed");
    assert.equal(r.supervisor.liveCount(), 0);
  });

  it("stopping twice, or after the worker ended by itself, is harmless", async () => {
    const r = rig();
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    assert.equal(await r.supervisor.stop(res.id), "ok");
    assert.equal(await r.supervisor.stop(res.id), "ok");
    assert.equal(r.events.filter((e) => e.type === "agent.status" && e.status === "stopped").length, 1);
  });

  it("reports an unknown id", async () => {
    const r = rig();
    assert.equal(await r.supervisor.stop("nope"), "not_found");
  });

  it("force-stops a worker that ignores the polite stop, including the processes it started", async () => {
    const r = rig({ stubborn: true, spawnChild: true });
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    const pid = r.sessions[0]?.childPid;
    assert.ok(pid && alive(pid), "the stand-in child process is running");
    await waitFor(() => r.sessions[0]?.grandchildPid != null);
    const grandchild = r.sessions[0]?.grandchildPid ?? 0;
    assert.ok(alive(grandchild), "the process it started is running");

    const t0 = Date.now();
    assert.equal(await r.supervisor.stop(res.id), "ok");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(r.sessions[0]?.aborted, true);
    assert.equal(r.registry.get(res.id)?.status, "stopped");
    await waitFor(() => !alive(pid) && !alive(grandchild), 5000);
    assert.ok(r.logs.some((l) => l["event"] === "managed-forced-stop"));
  });

  it("does not kill a process id after that process has exited, since the number could belong to something else now", async () => {
    const killed: number[] = [];
    const r = rig({ stubborn: true, spawnChild: true, childExits: true }, { killTree: async (pid) => void killed.push(pid) });
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    const pid = r.sessions[0]?.childPid;
    assert.ok(pid);
    await waitFor(() => !alive(pid), 5000);
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the exit be noticed
    assert.equal(await r.supervisor.stop(res.id), "ok");
    assert.equal(r.registry.get(res.id)?.status, "stopped");
    assert.deepEqual(killed, [], "no process was killed");
  });

  it("stops every worker with stop-all", async () => {
    const r = rig({}, { maxManaged: 6 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await r.supervisor.start({ cwd: r.work, prompt: `task ${i}` });
      assert.ok(res.ok);
      ids.push(res.id);
    }
    await r.supervisor.stopAll();
    for (const id of ids) assert.equal(r.registry.get(id)?.status, "stopped");
    assert.equal(r.supervisor.liveCount(), 0);
  });

  it("stop-all also ends a worker that is still starting", async () => {
    const r = rig({ initDelayMs: 200 });
    const pending = r.supervisor.start({ cwd: r.work, prompt: "x" });
    await waitFor(() => r.supervisor.starting());
    await r.supervisor.stopAll();
    assert.equal((await pending).ok, false);
    assert.equal(r.supervisor.liveCount(), 0);
  });
});

describe("supervisor: ended workers", () => {
  it("keeps an ended worker visible for a while, then forgets it", async () => {
    const r = rig({}, { forgetAfterMs: 120 });
    const res = await r.supervisor.start({ cwd: r.work, prompt: "x" });
    assert.ok(res.ok);
    await r.supervisor.stop(res.id);
    assert.equal(r.registry.has(res.id), true);
    assert.equal(r.supervisor.claims(res.id), true);
    await waitFor(() => !r.registry.has(res.id), 3000);
    assert.equal(r.supervisor.claims(res.id), false);
    assert.ok(r.events.some((e) => e.type === "agent.removed" && e.id === res.id));
  });
});
