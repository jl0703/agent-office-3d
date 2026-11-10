import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import { buildingFor } from "../src/office/building.ts";
import { visitSpot } from "../src/office/walk.ts";
import type { Person } from "../src/team.ts";
import { BREAK_COOLDOWN_MS, BREAK_HOLD_MS, HOLD_MS, IDLE_BEFORE_BREAK_MS, KICKOFF_HOLD_MS, MAX_BUBBLES, MAX_KICKOFF, MAX_TEXT, MAX_WALKERS, REDUCED_BUBBLE_MS, TOOL_BUBBLE_EVERY_MS, createStory, shorten } from "../src/office/story.ts";

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
// A building with all six department rooms, so that desks 0 to 41 and the Visitors desks exist.
const BUILDING = buildingFor(["Engineering", "Quality", "Design", "Product", "Operations", "Sales"].map((department, i): Person => ({ id: i.toString(16).padStart(12, "0"), name: `P${i}`, role: "r", brief: "", reportsTo: "000000000fff", department })));
const FREE = { reduced: false, frozen: false, building: BUILDING };
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
    const spot = visitSpot(BUILDING, 1);
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
    story.observe([master], seatsOf([master]), 0, { ...FREE, reduced: true });
    const child = agent({ parentId: master.id, currentTask: "Do it", status: "working" });
    const list = [master, child];
    story.observe(list, seatsOf(list), 100, { ...FREE, reduced: true });
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
    story.observe([master, finished], seatsOf(list), 20, { ...FREE, frozen: true });
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
    story.observe([master, { ...child, status: "done" as const, activity: "ok" }], seatsOf(list), 20, { ...FREE, reduced: true });
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

const roomRect = (key: string) => BUILDING.rooms.find((r) => r.key === key)!.rect;
const isIn = (p: { x: number; z: number }, key: string) => p.x > roomRect(key).minX && p.x < roomRect(key).maxX && p.z > roomRect(key).minZ && p.z < roomRect(key).maxZ;
const finishedWalking = (story: ReturnType<typeof createStory>, from: number, limit = 120_000) => {
  let t = from;
  while (story.frame(t).walkers.length > 0 && t < from + limit) t += 100;
  return t;
};
/** The moment the first walker stands still, looking from `from`. */
const untilStanding = (story: ReturnType<typeof createStory>, from: number, limit = 120_000) => {
  let t = from;
  while (story.frame(t).walkers[0]?.moving !== false && t < from + limit) t += 100;
  return t;
};

describe("a break in the Pantry or the Lounge", () => {
  const working = (over: Partial<Agent> = {}) => agent({ status: "working", ...over });

  it("sends an agent that has been idle for thirty seconds, not before, and shows where it went", () => {
    const idle = agent();
    const story = createStory();
    story.observe([idle], seatsOf([idle]), 0, FREE);
    assert.deepEqual(story.frame(IDLE_BEFORE_BREAK_MS - 1).walkers, [], "not yet");
    assert.equal(story.frame(IDLE_BEFORE_BREAK_MS).walkers.length, 1, "now");
    let t = untilStanding(story, IDLE_BEFORE_BREAK_MS);
    const there = story.frame(t);
    assert.equal(isIn(there.walkers[0]!, "pantry") || isIn(there.walkers[0]!, "lounge"), true, "standing in the Pantry or the Lounge");
    assert.deepEqual(there.bubbles, [{ agentId: idle.id, text: "Taking a break" }]);
    assert.equal(story.frame(t + BREAK_HOLD_MS - 100).walkers[0]?.moving, false, "stays for the hold");
    assert.equal(story.frame(t + BREAK_HOLD_MS + 200).walkers[0]?.moving, true, "then walks home");
    t = finishedWalking(story, t);
    assert.deepEqual(story.frame(t), { walkers: [], bubbles: [] });
  });

  it("sends the same agent to the same room each time, and different agents to both rooms", () => {
    const seenRooms = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const a = agent();
      const where = () => {
        const story = createStory();
        story.observe([a], seatsOf([a]), 0, FREE);
        const w = story.frame(untilStanding(story, IDLE_BEFORE_BREAK_MS)).walkers[0]!;
        return isIn(w, "pantry") ? "pantry" : isIn(w, "lounge") ? "lounge" : "elsewhere";
      };
      const first = where();
      assert.equal(where(), first, "the same room again");
      seenRooms.add(first);
    }
    assert.deepEqual([...seenRooms].sort(), ["lounge", "pantry"]);
  });

  it("does not send an agent that is working, waiting, finished, or when motion is reduced or the connection is down", () => {
    for (const status of ["working", "waiting", "done", "stopped", "error"] as const) {
      const a = agent({ status });
      const story = createStory();
      story.observe([a], seatsOf([a]), 0, FREE);
      assert.deepEqual(story.frame(IDLE_BEFORE_BREAK_MS * 3).walkers, [], status);
    }
    for (const opts of [{ ...FREE, reduced: true }, { ...FREE, frozen: true }]) {
      const a = agent();
      const story = createStory();
      story.observe([a], seatsOf([a]), 0, opts);
      assert.deepEqual(story.frame(IDLE_BEFORE_BREAK_MS * 3).walkers, []);
    }
  });

  it("counts idleness from the first update that says idle, and starts again when the agent works", () => {
    const a = agent();
    const story = createStory();
    story.observe([a], seatsOf([a]), 0, FREE);
    story.observe([{ ...a, status: "working" as const }], seatsOf([a]), 20_000, FREE);
    story.observe([a], seatsOf([a]), 25_000, FREE);
    assert.deepEqual(story.frame(25_000 + IDLE_BEFORE_BREAK_MS - 1).walkers, [], "thirty seconds after it went idle again, not after the first time");
    assert.equal(story.frame(25_000 + IDLE_BEFORE_BREAK_MS).walkers.length, 1);
  });

  it("brings the agent home at once when it starts working, with no words left behind", () => {
    const a = agent();
    const story = createStory();
    story.observe([a], seatsOf([a]), 0, FREE);
    assert.equal(story.frame(IDLE_BEFORE_BREAK_MS).walkers.length, 1);
    story.observe([{ ...a, status: "working" as const }], seatsOf([a]), IDLE_BEFORE_BREAK_MS + 500, FREE);
    assert.deepEqual(story.frame(IDLE_BEFORE_BREAK_MS + 500), { walkers: [], bubbles: [] });
  });

  it("lets one agent at a time take a break, the longest idle first, and not the same one again for two minutes", () => {
    const a = agent({ name: "a" });
    const b = agent({ name: "b" });
    const list = [a, b];
    const story = createStory();
    story.observe([a], seatsOf(list), 0, FREE);
    story.observe(list, seatsOf(list), 5000, FREE); // b has been idle for less time than a
    const first = story.frame(IDLE_BEFORE_BREAK_MS);
    assert.deepEqual(first.walkers.map((w) => w.agentId), [a.id], "a was idle first; b waits");
    const home = finishedWalking(story, IDLE_BEFORE_BREAK_MS);
    assert.deepEqual(story.frame(home).walkers.map((w) => w.agentId), [b.id], "then b");
    const t2 = finishedWalking(story, home);
    assert.deepEqual(story.frame(t2).walkers, [], "a is not due again yet");
    assert.ok(t2 < IDLE_BEFORE_BREAK_MS + BREAK_COOLDOWN_MS);
    assert.deepEqual(story.frame(IDLE_BEFORE_BREAK_MS + BREAK_COOLDOWN_MS).walkers.map((w) => w.agentId), [a.id], "a again after the pause");
  });

  it("keeps a place for a task visit: with three people already walking nobody goes on a break", () => {
    const master = working({ role: "master" });
    const kids = Array.from({ length: 3 }, () => working({ parentId: master.id }));
    const sleeper = agent();
    const list = [master, ...kids, sleeper];
    const story = createStory();
    story.observe(list, seatsOf(list), 0, FREE);
    story.observe([master, ...kids.map((k) => ({ ...k, status: "done" as const, activity: "ok" })), sleeper], seatsOf(list), 29_000, FREE);
    assert.equal(story.frame(29_000).walkers.length, 3);
    assert.equal(story.frame(IDLE_BEFORE_BREAK_MS).walkers.some((w) => w.agentId === sleeper.id), false);
  });

  it("forgets an agent that leaves", () => {
    const a = agent();
    const story = createStory();
    story.observe([a], seatsOf([a]), 0, FREE);
    assert.equal(story.frame(IDLE_BEFORE_BREAK_MS).walkers.length, 1);
    const other = agent({ status: "working" });
    story.observe([other], seatsOf([other]), IDLE_BEFORE_BREAK_MS + 100, FREE);
    assert.deepEqual(story.frame(IDLE_BEFORE_BREAK_MS + 100), { walkers: [], bubbles: [] });
  });
});

describe("a kick-off in the Meeting room", () => {
  const master = () => agent({ role: "master", status: "working" });
  const worker = (m: Agent, task: string) => agent({ parentId: m.id, currentTask: task, status: "working" });

  it("takes a master and its workers, given tasks together, to the table, with the first task as the master's words", () => {
    const m = master();
    const story = createStory();
    story.observe([m], seatsOf([m]), 0, FREE);
    const a = worker(m, "Fix the login form");
    const b = worker(m, "Write the tests");
    const list = [m, a, b];
    story.observe(list, seatsOf(list), 1000, FREE);
    const early = story.frame(1000);
    assert.deepEqual(early.walkers.map((w) => w.agentId).sort(), [m.id, a.id, b.id].sort());
    assert.deepEqual(early.bubbles, [], "no words before the master arrives");
    let t = 1000;
    while (story.frame(t).walkers.some((w) => w.moving)) t += 100;
    const there = story.frame(t);
    assert.equal(there.walkers.length, 3);
    for (const w of there.walkers) assert.equal(isIn(w, "meeting"), true, `${w.agentId} is in the Meeting room`);
    assert.deepEqual(there.bubbles, [{ agentId: m.id, text: "Kick-off: Fix the login form" }]);
    assert.equal(new Set(there.walkers.map((w) => `${w.x.toFixed(2)},${w.z.toFixed(2)}`)).size, 3, "each stands in a place of their own");
    t = finishedWalking(story, t);
    assert.deepEqual(story.frame(t), { walkers: [], bubbles: [] });
  });

  it("takes the master and three workers at most; the others get what they got before", () => {
    const m = master();
    const story = createStory();
    story.observe([m], seatsOf([m]), 0, FREE);
    const kids = Array.from({ length: 5 }, (_, i) => worker(m, `task ${i}`));
    const list = [m, ...kids];
    story.observe(list, seatsOf(list), 1000, FREE);
    const f = story.frame(1000);
    assert.equal(f.walkers.length, MAX_KICKOFF);
    assert.equal(MAX_KICKOFF, MAX_WALKERS);
    assert.ok(f.walkers.some((w) => w.agentId === m.id));
  });

  it("still walks one worker's task to its desk, as before", () => {
    const m = master();
    const story = createStory();
    story.observe([m], seatsOf([m]), 0, FREE);
    const a = worker(m, "One thing");
    story.observe([m, a], seatsOf([m, a]), 1000, FREE);
    let t = 1000;
    while (story.frame(t).walkers[0]?.moving) t += 100;
    assert.equal(isIn(story.frame(t).walkers[0]!, "meeting"), false);
    assert.deepEqual(story.frame(t).bubbles, [{ agentId: a.id, text: "One thing" }]);
  });

  it("does not go when there is not room for everyone to walk: then it is the desk visits", () => {
    const m = master();
    const finishers = Array.from({ length: 2 }, () => agent({ parentId: m.id, status: "working" }));
    const base = [m, ...finishers];
    const story = createStory();
    story.observe(base, seatsOf(base), 0, FREE);
    const a = worker(m, "A");
    const b = worker(m, "B");
    const c = worker(m, "C");
    const list = [m, ...finishers.map((k) => ({ ...k, status: "done" as const, activity: "ok" })), a, b, c];
    // Two workers finish in the same update, so two walks are already going and a group of four will not fit.
    story.observe(list, seatsOf(list), 500, FREE);
    const f = story.frame(500);
    assert.equal(f.walkers.some((w) => isIn(w, "meeting")), false, "nobody is in the Meeting room");
    assert.equal(f.walkers.length <= MAX_WALKERS, true);
  });

  it("is only bubbles at the desks with reduced motion", () => {
    const m = master();
    const story = createStory();
    story.observe([m], seatsOf([m]), 0, { ...FREE, reduced: true });
    const list = [m, worker(m, "X"), worker(m, "Y")];
    story.observe(list, seatsOf(list), 100, { ...FREE, reduced: true });
    assert.deepEqual(story.frame(100).walkers, []);
    assert.equal(story.frame(100 + REDUCED_BUBBLE_MS - 1).bubbles.length > 0, true, "words at the desks");
  });

  it("drops a walker whose agent leaves and keeps the rest of the group", () => {
    const m = master();
    const story = createStory();
    story.observe([m], seatsOf([m]), 0, FREE);
    const a = worker(m, "A");
    const b = worker(m, "B");
    story.observe([m, a, b], seatsOf([m, a, b]), 1000, FREE);
    story.observe([m, a], seatsOf([m, a]), 1500, FREE);
    assert.deepEqual(story.frame(1500).walkers.map((w) => w.agentId).sort(), [m.id, a.id].sort());
  });

  it("holds the group at the table for the kick-off time", () => {
    const m = master();
    const story = createStory();
    story.observe([m], seatsOf([m]), 0, FREE);
    const list = [m, worker(m, "A"), worker(m, "B")];
    story.observe(list, seatsOf(list), 1000, FREE);
    let t = 1000;
    while (story.frame(t).walkers.some((w) => w.moving)) t += 100;
    assert.equal(story.frame(t + KICKOFF_HOLD_MS - 300).walkers.every((w) => !w.moving), true, "still standing before the hold is over");
    t = finishedWalking(story, t);
    assert.equal(story.frame(t).walkers.length, 0);
  });
});
