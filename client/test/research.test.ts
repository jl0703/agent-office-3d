import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { briefFor, byNewest, evaluateFinding, getConfig, getFindings, getSchedule, setSchedule, safeLink, saveConfig, setDecision, startSweep, type Finding } from "../src/research.ts";

type Call = { path: string; init?: RequestInit };
const fake = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fn = async (path: string, init?: RequestInit) => {
    calls.push(init === undefined ? { path } : { path, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Pick<Response, "ok" | "status" | "json">;
  };
  return { fn, calls };
};

const raw = (over: Record<string, unknown> = {}) => ({
  id: "a-b",
  kind: "mcp",
  title: "A tool",
  url: "https://github.com/a/b",
  relevance: 4,
  effort: "low",
  risk: "medium",
  found_by: "repo-scout",
  date: "2026-11-05",
  why: "It adds code review.",
  status: "new",
  stars: 1200,
  license: "MIT",
  ...over,
});

describe("research helpers", () => {
  it("reads findings, drops malformed ones, clamps relevance, and gives null for odd answers", async () => {
    const ok = fake(200, { findings: [raw(), raw({ id: "x", kind: "weird" }), raw({ id: "y", relevance: 9 }), "junk", raw({ id: "z", status: "maybe" })], invalid: 2 });
    const got = await getFindings(ok.fn);
    assert.deepEqual(got?.findings.map((f) => f.id), ["a-b", "y"]);
    assert.equal(got?.findings[1]?.relevance, 5);
    assert.equal(got?.invalid, 2);
    assert.equal(ok.calls[0]?.path, "/api/research/findings");
    assert.equal(await getFindings(fake(200, { findings: "no" }).fn), null);
    assert.equal(await getFindings(fake(403, {}).fn), null);
    assert.equal(await getFindings(async () => Promise.reject(new Error("offline"))), null);
  });

  it("sends decisions, the sweep and the config, with plain messages for refusals", async () => {
    const d = fake(200, {});
    assert.deepEqual(await setDecision("a/b", "adopt", "later maybe", d.fn), { ok: true });
    assert.equal(d.calls[0]?.path, "/api/research/findings/a%2Fb/decision");
    assert.deepEqual(JSON.parse(String(d.calls[0]?.init?.body)), { status: "adopt", note: "later maybe" });
    await setDecision("x", "reject", undefined, d.fn);
    assert.deepEqual(JSON.parse(String(d.calls[1]?.init?.body)), { status: "reject" });
    const busy = await startSweep(fake(409, { reason: "sweep_running" }).fn);
    assert.deepEqual(busy, { ok: false, message: "A sweep is already running." });
    const none = await startSweep(fake(400, { error: "no_research_folder" }).fn);
    assert.equal(none.ok, false);
    assert.ok(!none.ok && none.message.includes("OFFICE_VAULT_DIR"));
    assert.deepEqual(await saveConfig({ focus: ["a"], needs: "n" }, fake(200, {}).fn), { ok: true });
    assert.equal((await startSweep(async () => Promise.reject(new Error("x")))).ok, false);
  });

  it("reads the config only when it has the right shape", async () => {
    assert.deepEqual(await getConfig(fake(200, { focus: ["a", "b"], needs: "n" }).fn), { focus: ["a", "b"], needs: "n" });
    assert.equal(await getConfig(fake(200, { focus: [1], needs: "n" }).fn), null);
    assert.equal(await getConfig(fake(200, { focus: [] }).fn), null);
  });

  it("offers a link only for a plain https address", () => {
    assert.equal(safeLink("https://github.com/a/b"), true);
    for (const bad of ["http://x.com", "javascript:alert(1)", "data:text/html,x", "https://x.com/a b", "https://x\u0000.com", "//x.com", ""]) assert.equal(safeLink(bad), false, bad);
  });

  it("writes a brief that asks for a plan first and treats the source as untrusted", () => {
    const f = raw({ note: "needs a tool for review" }) as unknown as Finding;
    const brief = briefFor(f);
    assert.ok(brief.includes("https://github.com/a/b"));
    assert.ok(brief.includes("licence MIT"));
    assert.ok(brief.includes("needs a tool for review"));
    assert.ok(/plan/i.test(brief) && /untrusted/i.test(brief));
    assert.ok(!briefFor({ ...f, note: undefined } as Finding).includes("owner's note"));
  });

  it("orders newest first, then most relevant", () => {
    const list = [raw({ id: "a", date: "2026-11-01", relevance: 5 }), raw({ id: "b", date: "2026-11-05", relevance: 2 }), raw({ id: "c", date: "2026-11-05", relevance: 4 })] as unknown as Finding[];
    assert.deepEqual([...list].sort(byNewest).map((f) => f.id), ["c", "b", "a"]);
  });

  it("reads the schedule, rejects odd answers, and sends only the mode", async () => {
    const ok = fake(200, { mode: "daily", nextRunAt: "2026-11-07T00:00:00.000Z", lastRunAt: null, lastSkipped: { reason: "budget", at: "2026-11-06T00:00:00.000Z" } });
    assert.deepEqual(await getSchedule(ok.fn), { mode: "daily", nextRunAt: "2026-11-07T00:00:00.000Z", lastRunAt: null, lastSkipped: { reason: "budget", at: "2026-11-06T00:00:00.000Z" } });
    assert.equal(await getSchedule(fake(200, { mode: "hourly" }).fn), null);
    assert.equal(await getSchedule(fake(403, {}).fn), null);
    assert.equal((await import("../src/research.ts")).SKIP_WORD["near_cap"], "the usage cap was near");
    const post = fake(200, {});
    assert.deepEqual(await setSchedule("weekly", post.fn), { ok: true });
    assert.deepEqual(JSON.parse(String(post.calls[0]?.init?.body)), { mode: "weekly" });
  });
});

describe("the fit check on the page", () => {
  const fit = { verdict: "fits", how: "Copy it", conflicts: "none", security: "text only", effort: "low", rollback: "delete it", date: "2026-11-06" };

  it("reads a report, drops an odd one, and the request goes to the evaluate route with the right messages", async () => {
    const got = await getFindings(fake(200, { findings: [raw({ fit }), raw({ id: "b", fit: { ...fit, verdict: "great" } }), raw({ id: "c", fit: { ...fit, how: 5 } })], invalid: 0 }).fn);
    assert.equal(got?.findings[0]?.fit?.verdict, "fits");
    assert.equal(got?.findings[1]?.fit, undefined);
    assert.equal(got?.findings[2]?.fit, undefined);
    const ok = fake(202, { id: "x" });
    assert.deepEqual(await evaluateFinding("a-b", ok.fn), { ok: true });
    assert.equal(ok.calls[0]?.path, "/api/research/findings/a-b/evaluate");
    const busy = await evaluateFinding("a-b", fake(409, { reason: "evaluating" }).fn);
    assert.equal(busy.ok === false && /already running/.test(busy.message), true);
  });
});
