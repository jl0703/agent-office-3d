import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import { visitSpot } from "../src/office/paths.ts";
import { HOLD_MS, MAX_BUBBLES, MAX_TEXT, MAX_WALKERS, REDUCED_BUBBLE_MS, TOOL_BUBBLE_EVERY_MS, createStory, shorten } from "../src/office/story.ts";

let n = 0;
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: `s${n++}`,
  kind: "session",
  origin: "observed",
  role: "solo",
  parentId: null,
  name: "agent",
  project: "web",
  status: "idle",
  currentTask: null,
  tool: null,
  activity: null,
  desk: 0,
  note: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const FREE = { reduced: false, frozen: false };
const seatsOf = (list: Agent[]) => new Map(list.map((a, i) => [a.id, i]));

describe("what the characters do", () => {
  it("treats the first picture as the starting point: nobody walks at load", () => {
    const master = agent({ role: "master" });
    const child = agent({ parentId: master.id, currentTask: "Fix it", status: "working" });
    const story = createStory();
    story.observe([master, child], seatsOf([master, child]), 0, FREE);
    assert.deepEqual(story.frame(1), { walkers: [], bubbles: [] });
  });

  it("sends a master to a new worker, shows the task when it arrives, and sends it home", () => {
    const master = agent({ role: "master" });
    const story = createStory();
    story.observe([master], seatsOf([master]), 0, FREE);
    const child = agent({ parentId: master.id, currentTask: "Fix the flaky checkout tests", status: "working" });
    const list = [master, child];
    story.observe(list, seatsOf(list), 1000, FREE);
    const early = story.frame(1000);
    assert.equal(early.walkers.length, 1);
    assert.equal(early.walkers[0]?.agentId, master.id);
    assert.equal(early.walkers[0]?.moving, true);
    assert.deepEqual(early.bubbles, [], "no words before the visitor arrives");
    let t = 1000;
    while (story.frame(t).walkers[0]?.moving) t += 100;
    const arrived = story.frame(t);
    assert.deepEqual(arrived.bubbles, [{ agentId: child.id, text: "Fix the flaky checkout tests" }]);
    const spot = visitSpot(1);
    const w = arrived.walkers[0] as { x: number; z: number };
    assert.ok(Math.hypot(w.x - spot.x, w.z - spot.z) < 0.5, "standing next to the worker");
    t += HOLD_MS + 50;
    assert.equal(story.frame(t).walkers[0]?.moving, true, "walking home");
    while (story.frame(t).walkers.length > 0) t += 100;
    assert.deepEqual(story.frame(t).bubbles, []);
  });

  it("sends a worker to its master when it finishes, with its last words", () => {
    const master = agent({ role: "master" });
    const child = agent({ parentId: master.id, status: "working", activity: "Edit invoice.ts" });
    const list = [master, child];
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    const done = { ...child, status: "done" as const, activity: "Wrote the report" };
    story.observe([master, done], seatsOf(list), 500, FREE);
    assert.equal(story.frame(500).walkers[0]?.agentId, child.id);
    let t = 500;
    while (story.frame(t).walkers[0]?.moving) t += 100;
    assert.deepEqual(story.frame(t).bubbles, [{ agentId: child.id, text: "Wrote the report" }]);
  });

  it("uses the note when a worker has one", () => {
    const master = agent();
    const child = agent({ parentId: master.id, status: "working" });
    const list = [master, child];
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    story.observe([master, { ...child, status: "error", note: "Stopped: the usage cap was reached." }], seatsOf(list), 10, FREE);
    let t = 10;
    while (story.frame(t).walkers[0]?.moving) t += 100;
    assert.equal(story.frame(t).bubbles[0]?.text, "Stopped: the usage cap was reached.");
  });

  it("lets at most four walk at once; the others only get their bubble at the desk", () => {
    const master = agent({ role: "master" });
    const kids = Array.from({ length: 6 }, (_, i) => agent({ parentId: master.id, status: "working", name: `k${i}` }));
    const list = [master, ...kids];
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    const finished = kids.map((k, i) => ({ ...k, status: "done" as const, activity: `result ${i}` }));
    story.observe([master, ...finished], seatsOf(list), 100, FREE);
    const f = story.frame(100);
    assert.equal(f.walkers.length, MAX_WALKERS);
    assert.ok(f.bubbles.length <= MAX_BUBBLES);
    assert.deepEqual(story.frame(100 + HOLD_MS + 20000), { walkers: [], bubbles: [] }, "everything ends");
  });

  it("says what a working agent is doing, at most once every eight seconds", () => {
    const a = agent({ status: "working", tool: "Read", activity: "config.ts" });
    const story = createStory();
    story.observe([a], seatsOf([a]), 0, FREE);
    story.observe([{ ...a, activity: "invoice.ts" }], seatsOf([a]), 1000, FREE);
    assert.deepEqual(story.frame(1000).bubbles, [{ agentId: a.id, text: "Read: invoice.ts" }]);
    story.observe([{ ...a, activity: "other.ts" }], seatsOf([a]), 1000 + TOOL_BUBBLE_EVERY_MS - 1, FREE);
    assert.equal(story.frame(1000 + 3000).bubbles[0]?.text, "Read: invoice.ts", "too soon for new words");
    story.observe([{ ...a, activity: "third.ts" }], seatsOf([a]), 1000 + TOOL_BUBBLE_EVERY_MS, FREE);
    assert.equal(story.frame(1000 + TOOL_BUBBLE_EVERY_MS).bubbles[0]?.text, "Read: third.ts");
  });

  it("with reduced motion nobody walks and a bubble lasts two seconds at the desk", () => {
    const master = agent();
    const story = createStory();
    story.observe([master], seatsOf([master]), 0, { reduced: true, frozen: false });
    const child = agent({ parentId: master.id, currentTask: "Do it", status: "working" });
    const list = [master, child];
    story.observe(list, seatsOf(list), 100, { reduced: true, frozen: false });
    const f = story.frame(100);
    assert.deepEqual(f.walkers, []);
    assert.deepEqual(f.bubbles, [{ agentId: child.id, text: "Do it" }]);
    assert.deepEqual(story.frame(100 + REDUCED_BUBBLE_MS + 1).bubbles, []);
  });

  it("stops everything when the connection is frozen, and forgets walks of agents that leave", () => {
    const master = agent();
    const child = agent({ parentId: master.id, status: "working" });
    const list = [master, child];
    const finished = { ...child, status: "done" as const, activity: "x" };
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    story.observe([master, finished], seatsOf(list), 10, FREE);
    assert.equal(story.frame(10).walkers.length, 1);
    story.observe([master, finished], seatsOf(list), 20, { reduced: false, frozen: true });
    assert.deepEqual(story.frame(20), { walkers: [], bubbles: [] });

    const other = createStory();
    other.observe(list, seatsOf(list), 0, FREE);
    other.observe([master, finished], seatsOf(list), 10, FREE);
    other.observe([master], seatsOf([master]), 50, FREE);
    assert.deepEqual(other.frame(50), { walkers: [], bubbles: [] }, "the child left");
  });

  it("does not walk for an agent with no seat, and keeps hostile text as text, cut to 80 characters", () => {
    const master = agent();
    const long = `<img src=x onerror=alert(1)> ${"x".repeat(200)}`;
    const child = agent({ parentId: master.id, currentTask: long, status: "working" });
    const list = [master, child];

    const unseated = createStory();
    unseated.observe([master], new Map([[master.id, 0]]), 0, FREE);
    unseated.observe(list, new Map([[master.id, 0]]), 10, FREE);
    assert.deepEqual(unseated.frame(10).walkers, [], "the child has no seat");

    const seated = createStory();
    seated.observe([master], seatsOf([master]), 0, FREE);
    seated.observe(list, seatsOf(list), 10, FREE);
    let t = 10;
    while (seated.frame(t).walkers[0]?.moving) t += 100;
    const text = seated.frame(t).bubbles[0]?.text ?? "";
    assert.ok(text.startsWith("<img src=x onerror=alert(1)>"));
    assert.equal(Array.from(text).length, MAX_TEXT + 1);
    assert.ok(text.endsWith("…"));
    assert.equal(shorten("  two\n\tlines "), "two lines");
    assert.equal(shorten("😀".repeat(81)), "😀".repeat(80) + "…");
  });

  it("treats a whole new list as a new starting point: switching to demo and back starts no walks", () => {
    const master = agent();
    const child = agent({ parentId: master.id, currentTask: "Real job", status: "working" });
    const real = [master, child];
    const story = createStory();
    story.observe(real, seatsOf(real), 0, FREE);
    const demoMaster = agent();
    const demoChild = agent({ parentId: demoMaster.id, currentTask: "Demo job", status: "working" });
    const fake = [demoMaster, demoChild];
    story.observe(fake, seatsOf(fake), 100, FREE);
    assert.deepEqual(story.frame(100), { walkers: [], bubbles: [] });
    story.observe([], new Map(), 200, FREE);
    story.observe(real, seatsOf(real), 300, FREE);
    assert.deepEqual(story.frame(300), { walkers: [], bubbles: [] }, "a list that comes back is not news either");
    // And the story works as usual afterwards.
    story.observe([master, { ...child, status: "done" as const, activity: "ok" }], seatsOf(real), 400, FREE);
    assert.equal(story.frame(400).walkers.length, 1);
  });

  it("sends everyone home when reduced motion is switched on mid-walk", () => {
    const master = agent();
    const child = agent({ parentId: master.id, status: "working" });
    const list = [master, child];
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    story.observe([master, { ...child, status: "done" as const, activity: "ok" }], seatsOf(list), 10, FREE);
    assert.equal(story.frame(10).walkers.length, 1);
    story.observe([master, { ...child, status: "done" as const, activity: "ok" }], seatsOf(list), 20, { reduced: true, frozen: false });
    assert.deepEqual(story.frame(20).walkers, []);
  });

  it("does not let a tool bubble replace words still waiting to be heard", () => {
    const master = agent();
    const child = agent({ parentId: master.id, status: "working", tool: "Read", activity: "a.ts" });
    const list = [master, child];
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    story.observe([master, { ...child, currentTask: "Fix it", activity: "b.ts" }], seatsOf(list), 1000, FREE);
    // The master is still walking over; the worker has activity again, but must not overwrite the task.
    story.observe([master, { ...child, currentTask: "Fix it", activity: "c.ts" }], seatsOf(list), 1500, FREE);
    let t = 1000;
    while (story.frame(t).walkers[0]?.moving) t += 100;
    assert.equal(story.frame(t).bubbles[0]?.text, "Fix it");
  });
});
