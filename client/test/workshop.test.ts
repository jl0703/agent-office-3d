import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demoBuilds, getBuilds, getPatch, lineKind, reviseBuild, startBuild } from "../src/workshop.ts";

const fake = (status: number, body: unknown) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fn = async (path: string, init?: RequestInit) => {
    calls.push(init === undefined ? { path } : { path, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Pick<Response, "ok" | "status" | "json">;
  };
  return { fn, calls };
};
const build = (over: Record<string, unknown> = {}) => ({ id: "0123456789ab", finding: "tool-a", title: "Tool A", createdAt: 1, status: "ready", files: 3, changed: 1, ...over });

describe("workshop on the page", () => {
  it("reads builds, drops odd ones, and tells off, odd and unreachable apart", async () => {
    const got = await getBuilds(fake(200, { builds: [build(), build({ status: "weird" }), build({ files: "3" }), "x"], dir: "C:/data/workshop" }).fn);
    assert.deepEqual([got !== null && got !== "off" && got.builds.length, got !== null && got !== "off" && got.dir], [1, "C:/data/workshop"]);
    assert.equal(await getBuilds(fake(404, {}).fn), "off");
    assert.equal(await getBuilds(fake(200, { nope: 1 }).fn), null);
    assert.equal(await getBuilds(async () => Promise.reject(new Error("offline"))), null);
  });

  it("reads a patch and starts a build with the right request and messages", async () => {
    assert.deepEqual(await getPatch("0123456789ab", fake(200, { patch: "+x", truncated: true }).fn), { patch: "+x", truncated: true });
    assert.equal(await getPatch("0123456789ab", fake(404, {}).fn), null);
    const ok = fake(202, { id: "m", build: "b" });
    assert.deepEqual(await startBuild("tool-a", ok.fn), { ok: true });
    assert.equal(ok.calls[0]?.path, "/api/workshop/build");
    assert.equal(ok.calls[0]?.init?.body, JSON.stringify({ findingId: "tool-a" }));
    for (const [status, body, word] of [[409, { reason: "not_adopted" }, /Adopt/], [413, { error: "too_big" }, /too large/], [429, { error: "too_many_builds" }, /100 builds/], [429, { error: "too_many" }, /Too many agents/], [429, { error: "worker_limit" }, /Too many workers/], [409, { reason: "master_running" }, /master is already running/]] as const) {
      const r = await startBuild("tool-a", fake(status, body).fn);
      assert.equal(r.ok === false && word.test(r.message), true, JSON.stringify(body));
    }
  });

  it("sorts patch lines into header, added, removed and context, and has demo builds", () => {
    assert.deepEqual(["diff --git a b", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+new", "-old", " same"].map(lineKind), ["head", "head", "head", "head", "add", "del", "ctx"]);
    assert.equal(demoBuilds().some((b) => b.status === "ready"), true);
  });
});

describe("the next round on the page", () => {
  it("posts to the revise route with confirm, explains each refusal, and reads round and the earlier result from a build", async () => {
    const ok = fake(202, { id: "m", round: 2 });
    assert.deepEqual(await reviseBuild("0123456789ab", ok.fn), { ok: true });
    assert.equal(ok.calls[0]?.path, "/api/workshop/0123456789ab/revise");
    assert.equal(ok.calls[0]?.init?.body, JSON.stringify({ confirm: true }));
    for (const [status, body, word] of [[409, { reason: "no_eval" }, /Run the skill eval first/], [409, { reason: "rounds_used" }, /three rounds/], [409, { reason: "master_running" }, /master is already running/]] as const) {
      const r = await reviseBuild("0123456789ab", fake(status, body).fn);
      assert.equal(r.ok === false && word.test(r.message), true, JSON.stringify(body));
    }
    const summary = { verdict: "worse", withRate: 0.2, baselineRate: 0.5, delta: -0.3, costUsd: 0.1, capped: false, ranAt: 1 };
    const got = await getBuilds(fake(200, { builds: [build({ round: 2, evalBefore: summary, eval: { ...summary, verdict: "improves" } })], dir: "/d" }).fn);
    const b = got !== null && got !== "off" ? got.builds[0] : undefined;
    assert.deepEqual([b?.round, b?.evalBefore?.verdict, b?.eval?.verdict], [2, "worse", "improves"]);
  });
});
