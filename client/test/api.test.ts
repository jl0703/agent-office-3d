import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFailure, startWorker, stopAgent, stopAll } from "../src/api.ts";

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
    for (const code of ["invalid_request", "invalid_folder", "folder_not_allowed", "too_many", "start_failed", "too_large"]) {
      const text = describeFailure(400, code);
      assert.match(text, /\.$/, code);
      assert.ok(!text.includes(code), "no raw code shown");
    }
    assert.match(describeFailure(403, undefined), /expired/);
    assert.match(describeFailure(500, "internal"), /error 500/);
    assert.match(describeFailure(502, undefined), /error 502/);
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
});
