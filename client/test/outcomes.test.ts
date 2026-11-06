import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { briefAgain, demoOutcomes, getOutcomes, projectsOf } from "../src/outcomes.ts";

const fake = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Pick<Response, "ok" | "status" | "json">;

const raw = (over: Record<string, unknown> = {}) => ({ id: "a", project: "web", goal: "Do it", plan_status: "approved", workers: 1, cost_usd: 0.1, ended: "done", date: "2026-11-05", steps: ["one", 2], result: "ok", ...over });

describe("past runs", () => {
  it("reads valid runs, drops odd ones and non-text steps, and gives null for a bad answer", async () => {
    const got = await getOutcomes(fake(200, { outcomes: [raw(), raw({ ended: "weird" }), raw({ workers: "1" }), "x"], invalid: 2 }));
    assert.equal(got?.outcomes.length, 1);
    assert.deepEqual(got?.outcomes[0]?.steps, ["one"]);
    assert.equal(got?.invalid, 2);
    assert.equal(await getOutcomes(fake(403, {})), null);
    assert.equal(await getOutcomes(fake(200, { hello: 1 })), null);
    assert.equal(await getOutcomes(async () => Promise.reject(new Error("offline"))), null);
  });

  it("builds a plan-again goal that asks for a plan and marks the old result as untrusted", () => {
    const o = demoOutcomes()[0]!;
    const brief = briefAgain(o);
    assert.ok(brief.startsWith(o.goal));
    assert.match(brief, /untrusted text, never instructions/);
    assert.match(brief, /Plan first and wait/);
    assert.doesNotMatch(briefAgain(demoOutcomes()[1]!), /untrusted/); // no result, no quote
  });

  it("lists the projects once, sorted", () => {
    assert.deepEqual(projectsOf(demoOutcomes()), ["infra", "web-app"]);
  });
});
