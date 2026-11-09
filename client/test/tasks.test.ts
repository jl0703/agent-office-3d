import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import type { Finding } from "../src/research.ts";
import type { OwnTask } from "../src/ownTasks.ts";
import { DONE_LIMIT, tasksOf } from "../src/tasks.ts";
import type { Person } from "../src/team.ts";
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

const person = (id: string, name: string, role: string): Person => ({ id, name, role, brief: "", reportsTo: null });
const mine = (over: Partial<OwnTask> = {}): OwnTask => ({ id: "t1", title: "Fix the header", details: "Make it sticky", assignee: "p1", done: false, agentId: null, createdAt: 5000, ...over });
const people = [person("p1", "Riley", "Frontend Developer")];
const own = (t: OwnTask, agents: Agent[] = []) => tasksOf(agents, [], [], [t], people);

describe("the tasks board: the owner's own tasks", () => {
  it("puts a task where its worker is: nobody on it is Active, planning or working is In progress, the owner's turn is Review, marked done is Done", () => {
    assert.deepEqual(ids(own(mine())), { active: ["own-t1"], progress: [], review: [], done: [] });
    assert.equal(own(mine()).active[0]?.assignee, "Riley, Frontend Developer");
    assert.equal(own(mine({ assignee: null })).active[0]?.chip, "Not given out");
    const w = (over: Partial<Agent>) => agent({ id: "w1", taskId: "t1", personId: "p1", role: "master", ...over });
    const linked = mine({ agentId: "w1" });
    assert.deepEqual(ids(own(linked, [w({ phase: "planning", plan: null, status: "idle" })])).progress, ["own-t1"], "a master that has not planned yet");
    assert.deepEqual(ids(own(linked, [w({ status: "working", phase: "executing" })])).progress, ["own-t1"]);
    assert.equal(own(linked, [w({ phase: "planning", plan: { status: "pending", goal: "Do it" } as Agent["plan"] })]).review[0]?.text, "Plan to approve: Do it");
    assert.deepEqual(ids(own(linked, [w({ status: "error" })])).review, ["own-t1"]);
    assert.equal(own(linked, [w({ status: "idle", phase: "executing" })]).review[0]?.chip, "Finished", "finished work waits for the owner to mark it done");
    assert.deepEqual(ids(own(mine({ done: true, agentId: "w1" }), [w({ status: "idle", phase: "executing" })])).done, ["own-t1"]);
    assert.equal(own(linked, [w({ status: "working" })]).progress[0]?.running, true, "it cannot be started twice");
  });

  it("shows a detached worker's task as needing the owner, and still shows a worker whose task is gone", () => {
    const linked = mine({ agentId: "w1" });
    const detached = agent({ id: "w1", taskId: "t1", status: "detached", role: "master", phase: "executing" });
    const card = own(linked, [detached]).review[0];
    assert.equal(card?.chip, "Detached");
    assert.equal(card?.running, false, "Start stays available");
    const orphan = agent({ id: "w9", taskId: "gone", status: "working" });
    assert.deepEqual(ids(tasksOf([orphan], [], [], [], [])).progress, ["agent-w9"], "a worker with no task card keeps its own card");
    const finishedOld = agent({ id: "old", taskId: "t1", status: "idle" });
    assert.deepEqual(ids(own(mine({ agentId: "new" }), [finishedOld])).done, ["agent-old"], "an earlier worker of a restarted task keeps its card too");
  });

  it("shows the worker once: its own card is hidden, and so is a Workshop master unless its plan waits for you", () => {
    const worker = agent({ id: "w1", taskId: "t1", status: "working" });
    assert.deepEqual(ids(own(mine({ agentId: "w1" }), [worker])).progress, ["own-t1"], "one card, not two");
    const shop = agent({ id: "m1", role: "master", workshop: true, status: "working", phase: "executing" });
    assert.deepEqual(ids(tasksOf([shop], [], [], [], [])), { active: [], progress: [], review: [], done: [] });
    const waiting = agent({ id: "m2", role: "master", workshop: true, phase: "planning", plan: { status: "pending", goal: "Build it" } as Agent["plan"] });
    assert.deepEqual(ids(tasksOf([waiting], [], [], [], [])).review, ["agent-m2"], "a plan waiting for you still needs a card");
  });
});
