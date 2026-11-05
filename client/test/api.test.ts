import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignTask, describeFailure, getAgentEvents, getVault, resumeAgent, startMaster, startResearch, startWorker, stopAgent, stopAll } from "../src/api.ts";

type Call = { path: string; init?: RequestInit };
const fakeFetch = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fn = async (path: string, init?: RequestInit) => {
    calls.push(init === undefined ? { path } : { path, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Pick<Response, "ok" | "status" | "json">;
  };
  return { fn, calls };
};

describe("api helpers", () => {
  it("sends the worker request as JSON", async () => {
    const f = fakeFetch(201, { id: "a" });
    assert.deepEqual(await startWorker("C:\\work", "do it", f.fn), { ok: true });
    assert.equal(f.calls[0]?.path, "/api/agents");
    assert.equal(f.calls[0]?.init?.method, "POST");
    assert.deepEqual(f.calls[0]?.init?.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(f.calls[0]?.init?.body)), { role: "worker", cwd: "C:\\work", prompt: "do it" });
  });

  it("stops one worker or all, with the id made safe for the address", async () => {
    const one = fakeFetch(202, {});
    assert.deepEqual(await stopAgent("a/b c", one.fn), { ok: true });
    assert.equal(one.calls[0]?.path, "/api/agents/a%2Fb%20c/stop");
    const all = fakeFetch(202, {});
    assert.deepEqual(await stopAll(all.fn), { ok: true });
    assert.equal(all.calls[0]?.path, "/api/agents/stop-all");
  });

  it("turns each server answer into a plain sentence", () => {
    const codes = ["invalid_request", "invalid_folder", "folder_not_allowed", "too_many", "start_failed", "too_large"];
    const newCodes = ["busy", "stopped", "detached", "observed", "not_resumable", "transcript_active", "budget", "not_found"];
    for (const code of [...codes, ...newCodes]) {
      const text = describeFailure(400, code);
      assert.match(text, /\.$/, code);
      assert.ok(!text.includes(code), "no raw code shown");
    }
    assert.match(describeFailure(403, undefined), /expired/);
    assert.match(describeFailure(500, "internal"), /error 500/);
    assert.match(describeFailure(502, undefined), /error 502/);
  });

  it("gives a task or resumes a worker, sending only the message", async () => {
    const task = fakeFetch(202, {});
    assert.deepEqual(await assignTask("a/b", "next job", task.fn), { ok: true });
    assert.equal(task.calls[0]?.path, "/api/agents/a%2Fb/tasks");
    assert.equal(task.calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(task.calls[0]?.init?.body)), { prompt: "next job" });
    const resume = fakeFetch(202, {});
    assert.deepEqual(await resumeAgent("a", "Continue where you left off.", resume.fn), { ok: true });
    assert.equal(resume.calls[0]?.path, "/api/agents/a/resume");
    assert.deepEqual(JSON.parse(String(resume.calls[0]?.init?.body)), { prompt: "Continue where you left off." });
  });

  it("explains a conflict from its reason, and a refusal from its error code", async () => {
    const busy = fakeFetch(409, { reason: "busy" });
    assert.deepEqual(await assignTask("a", "x", busy.fn), { ok: false, message: describeFailure(409, "busy") });
    assert.match(describeFailure(409, "busy"), /occupied/);
    const budget = fakeFetch(429, { error: "budget" });
    assert.deepEqual(await resumeAgent("a", "x", budget.fn), { ok: false, message: describeFailure(429, "budget") });
    assert.match(describeFailure(429, "budget"), /usage cap/);
    const unknown = fakeFetch(409, { reason: "something-new" });
    assert.deepEqual(await assignTask("a", "x", unknown.fn), { ok: false, message: describeFailure(409, undefined) });
  });

  it("explains folder refusals at resume, not as an expired session", () => {
    assert.doesNotMatch(describeFailure(403, "folder_not_allowed"), /expired/);
    assert.match(describeFailure(403, "folder_not_allowed"), /OFFICE_ALLOWED_ROOTS/);
    assert.match(describeFailure(400, "invalid_folder"), /does not exist/);
  });

  it("reports a failure with the matching message, and a network failure", async () => {
    const refused = fakeFetch(429, { error: "too_many" });
    assert.deepEqual(await startWorker("C:\\w", "x", refused.fn), { ok: false, message: describeFailure(429, "too_many") });
    const unreadable = { ok: false, status: 500, json: async () => Promise.reject(new Error("not json")) };
    const result = await stopAgent("a", async () => unreadable as unknown as Pick<Response, "ok" | "status" | "json">);
    assert.deepEqual(result, { ok: false, message: describeFailure(500, undefined) });
    const down = await stopAll(async () => Promise.reject(new Error("offline")));
    assert.deepEqual(down, { ok: false, message: "Could not reach the server." });
  });

  it("ignores an error field that is not text", async () => {
    const odd = fakeFetch(400, { error: { nested: true } });
    assert.deepEqual(await startWorker("C:\\w", "x", odd.fn), { ok: false, message: describeFailure(400, undefined) });
  });

  it("reads an agent's recent events, or null when the server says no or cannot be reached", async () => {
    const ok = fakeFetch(200, { events: [{ ts: "t", tool: "Read", summary: "a.ts" }] });
    assert.deepEqual(await getAgentEvents("a/b", ok.fn), [{ ts: "t", tool: "Read", summary: "a.ts" }]);
    assert.equal(ok.calls[0]?.path, "/api/agents/a%2Fb/events");
    assert.equal(await getAgentEvents("a", fakeFetch(404, {}).fn), null);
    assert.equal(await getAgentEvents("a", fakeFetch(200, { events: "no" }).fn), null);
    assert.equal(await getAgentEvents("a", async () => Promise.reject(new Error("offline"))), null);
  });

  it("reads the vault, asking for a rescan only when told to, and gives null for anything unexpected", async () => {
    const ok = fakeFetch(200, { connected: false });
    assert.deepEqual(await getVault(false, ok.fn), { connected: false });
    assert.equal(ok.calls[0]?.path, "/api/vault");
    await getVault(true, ok.fn);
    assert.equal(ok.calls[1]?.path, "/api/vault?refresh=1");
    assert.equal(await getVault(false, fakeFetch(403, {}).fn), null);
    assert.equal(await getVault(false, fakeFetch(200, { hello: 1 }).fn), null);
    assert.equal(await getVault(false, async () => Promise.reject(new Error("offline"))), null);
  });

  it("starts a master with its goal as the prompt, and explains a second master", async () => {
    const f = fakeFetch(201, { id: "m" });
    assert.deepEqual(await startMaster("C:\\work", "do the big job", f.fn), { ok: true });
    assert.deepEqual(JSON.parse(String(f.calls[0]?.init?.body)), { role: "master", cwd: "C:\\work", prompt: "do the big job" });
    const refused = fakeFetch(409, { reason: "master_running" });
    assert.deepEqual(await startMaster("C:\\w", "x", refused.fn), { ok: false, message: describeFailure(409, "master_running") });
    assert.ok(describeFailure(409, "master_running").includes("master"));
  });

  it("starts a research team with only the topic, and explains a missing research folder", async () => {
    const f = fakeFetch(201, { id: "r" });
    assert.deepEqual(await startResearch("top MCP servers for code review", f.fn), { ok: true });
    assert.deepEqual(JSON.parse(String(f.calls[0]?.init?.body)), { role: "master", team: "research", prompt: "top MCP servers for code review" });
    const none = fakeFetch(400, { error: "no_research_folder" });
    assert.deepEqual(await startResearch("x", none.fn), { ok: false, message: describeFailure(400, "no_research_folder") });
    assert.ok(describeFailure(400, "no_research_folder").includes("OFFICE_VAULT_DIR"));
  });
});
