import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import type { Finding } from "../src/research.ts";
import { DONE_LIMIT, tasksOf } from "../src/tasks.ts";
import type { Build } from "../src/workshop.ts";

const agent = (over: Partial<Agent>): Agent => ({ id: "a1", kind: "session", origin: "managed", role: "worker", parentId: null, name: "Worker", project: "p", status: "working", currentTask: "Fix things", tool: null, activity: null, desk: 1, updatedAt: "2026-11-09T10:00:00Z", note: null, ...over });
const build = (over: Partial<Build>): Build => ({ id: "b1", finding: "tool-a", title: "Tool A", createdAt: 1000, status: "building", files: 5, changed: 2, ...over });
const find = (over: Partial<Finding>): Finding => ({ id: "tool-a", kind: "skill", title: "Tool A", url: "https://x.y", relevance: 4, effort: "low", risk: "low", found_by: "scout", date: "2026-11-08", why: "Because", status: "adopt", ...over });
const ids = (c: ReturnType<typeof tasksOf>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.map((t) => t.id)]));

describe("the tasks board", () => {
  it("puts agents where their state says: working, needing you, finished", () => {
    const c = tasksOf(
      [
        agent({ id: "w", status: "working" }),
        agent({ id: "p", role: "master", status: "working", phase: "planning", plan: { status: "pending", goal: "Do it" } as Agent["plan"] }),
        agent({ id: "e", status: "error", note: "Boom" }),
        agent({ id: "q", status: "waiting" }),
        agent({ id: "d", status: "done" }),
        agent({ id: "s", kind: "subagent", parentId: "w" }),
        agent({ id: "x", status: "detached" }),
      ],
      [],
      [],
    );
    assert.deepEqual(ids(c), { active: [], progress: ["agent-w"], review: ["agent-e", "agent-p", "agent-q"], done: ["agent-d"] }, "subagents and detached sessions have no card");
    assert.equal(c.review.find((t) => t.id === "agent-p")?.text, "Plan to approve: Do it");
  });

  it("follows a build from building to patch ready to finished, and lists adopted finds that have no build", () => {
    assert.deepEqual(ids(tasksOf([], [build({ status: "building" })], [find({})])), { active: [], progress: ["build-b1"], review: [], done: [] }, "an adopted find with a build is not listed twice");
    assert.deepEqual(ids(tasksOf([], [], [find({}), find({ id: "other", status: "looking" })])), { active: ["find-tool-a"], progress: [], review: [], done: [] }, "only adopted finds");
    const ready = tasksOf([], [build({ status: "ready", eval: { verdict: "improves", withRate: 1, baselineRate: 0.5, delta: 0.5, costUsd: 0.1, capped: false, ranAt: 1 } })], []);
    assert.match(ready.review[0]?.text ?? "", /Eval: Improves/);
    assert.deepEqual(ids(tasksOf([], [build({ status: "no-changes" }), build({ id: "b2", status: "error" })], [])), { active: [], progress: [], review: ["build-b2"], done: ["build-b1"] });
    assert.match(tasksOf([], [build({ status: "building", evalRun: { done: 1, total: 3 } })], []).progress[0]?.text ?? "", /Eval running: 1 of 3/);
  });

  it("lists the newest first and keeps only the newest in Done", () => {
    const many = Array.from({ length: DONE_LIMIT + 5 }, (_, i) => agent({ id: `d${i}`, status: "done", updatedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() }));
    const done = tasksOf(many, [], []).done;
    assert.equal(done.length, DONE_LIMIT);
    assert.equal(done[0]?.id, `agent-d${DONE_LIMIT + 4}`);
  });
});
