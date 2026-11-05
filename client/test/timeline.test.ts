import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEntry, Agent } from "../../shared/events.ts";
import { familyOf, relativeTime, shortDuration, timelineOf } from "../src/timeline.ts";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();
const NOW = Date.UTC(2026, 0, 1, 12, 5, 0);
let n = 0;
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: `g${n++}`,
  kind: "session",
  origin: "managed",
  role: "worker",
  parentId: null,
  name: "agent",
  project: "web",
  status: "working",
  currentTask: null,
  tool: null,
  activity: null,
  desk: 0,
  note: null,
  updatedAt: at(0),
  ...over,
});

describe("relative times and durations", () => {
  it("says how long ago, in the unit that fits", () => {
    assert.equal(relativeTime(at(298), NOW), "just now");
    assert.equal(relativeTime(at(250), NOW), "50 s ago");
    assert.equal(relativeTime(at(0), NOW), "5 min ago");
    assert.equal(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW), "3 h ago");
    assert.equal(relativeTime("not a date", NOW), "");
    assert.equal(relativeTime(at(400), NOW), "just now", "a time in the future is not negative");
    assert.equal(relativeTime(new Date(NOW - 4400).toISOString(), NOW), "just now");
    assert.equal(relativeTime(new Date(NOW - 5000).toISOString(), NOW), "5 s ago");
    assert.equal(relativeTime(new Date(NOW - 60_000).toISOString(), NOW), "1 min ago");
    assert.equal(relativeTime(new Date(NOW - 3_600_000).toISOString(), NOW), "1 h ago");
    assert.match(relativeTime(new Date(NOW - 86_400_000).toISOString(), NOW), /\d/, "a day or more gives a date");
  });

  it("shortens durations", () => {
    assert.equal(shortDuration(800), "0.8 s");
    assert.equal(shortDuration(4000), "4 s");
    assert.equal(shortDuration(42_400), "42 s");
    assert.equal(shortDuration(125_000), "2 min 5 s");
    assert.equal(shortDuration(59_600), "1 min 0 s", "rounding carries into the minute");
    assert.equal(shortDuration(119_600), "2 min 0 s");
    assert.equal(shortDuration(9_960), "10 s");
  });
});

describe("timeline", () => {
  const entries: ActivityEntry[] = [
    { ts: at(0), tool: "Read", summary: "a.ts" },
    { ts: at(4), tool: "Edit", summary: "a.ts" },
    { ts: at(6), tool: "Edit", summary: "a.ts" },
    { ts: at(16), tool: "Write", summary: "notes.md" },
  ];

  it("lists newest first, folds identical calls, and measures each call until the next began", () => {
    const items = timelineOf(entries, NOW, false);
    assert.deepEqual(items.map((i) => [i.tool, i.count]), [["Write", 1], ["Edit", 2], ["Read", 1]]);
    assert.equal(items[2]?.durationMs, 4000);
    assert.equal(items[1]?.durationMs, 12_000, "from the first of the folded calls to the next call");
    assert.equal(items[0]?.durationMs, null, "the newest has no next call and the agent is not working");
    assert.equal(items[1]?.share, 1);
    assert.ok(Math.abs((items[2]?.share ?? 0) - 1 / 3) < 1e-9);
  });

  it("keeps calls that are not next to each other apart, and gives no duration for odd gaps", () => {
    const abab: ActivityEntry[] = [
      { ts: at(0), tool: "Read", summary: "a" },
      { ts: at(2), tool: "Edit", summary: "b" },
      { ts: at(4), tool: "Read", summary: "a" },
    ];
    assert.deepEqual(timelineOf(abab, NOW, false).map((i) => i.count), [1, 1, 1]);
    const backwards: ActivityEntry[] = [
      { ts: at(10), tool: "Read", summary: "a" },
      { ts: at(5), tool: "Edit", summary: "b" },
    ];
    assert.equal(timelineOf(backwards, NOW, false)[1]?.durationMs, null, "a later call that is stamped earlier gives no duration");
    const garbageNext: ActivityEntry[] = [
      { ts: at(0), tool: "Read", summary: "a" },
      { ts: "garbage", tool: "Edit", summary: "b" },
    ];
    assert.equal(timelineOf(garbageNext, NOW, false)[1]?.durationMs, null);
  });

  it("keeps the live row's duration even when the clock is a moment older than the newest call", () => {
    const fresh: ActivityEntry[] = [{ ts: at(100), tool: "Read", summary: "a" }];
    const oldClock = Date.parse(at(98));
    assert.equal(timelineOf(fresh, oldClock, true)[0]?.durationMs, 0);
  });

  it("measures the newest call until now while the agent is working", () => {
    const items = timelineOf(entries, NOW, true);
    assert.equal(items[0]?.durationMs, NOW - Date.parse(at(16)));
  });

  it("copes with nothing, with a missing tool name and with odd times", () => {
    assert.deepEqual(timelineOf([], NOW, true), []);
    const [only] = timelineOf([{ ts: "garbage", tool: null, summary: "x" }], NOW, true);
    assert.equal(only?.tool, "tool");
    assert.equal(only?.durationMs, null);
    assert.equal(only?.share, 0);
  });
});

describe("family", () => {
  it("finds the session an agent belongs to and everyone below it, in order", () => {
    const master = agent({ name: "lead", role: "master" });
    const b = agent({ name: "b", parentId: master.id });
    const a = agent({ name: "a", parentId: master.id });
    const grandchild = agent({ name: "g", parentId: a.id });
    const stranger = agent({ name: "other" });
    const all = [master, b, a, grandchild, stranger];
    for (const id of [master.id, b.id, grandchild.id]) {
      const family = familyOf(all, id);
      assert.equal(family?.root.id, master.id);
      assert.deepEqual(family?.members.map((m) => [m.agent.name, m.depth]), [["a", 1], ["g", 2], ["b", 1]]);
    }
    assert.equal(familyOf(all, stranger.id), null, "alone: no family");
    assert.equal(familyOf(all, "missing"), null);
  });

  it("survives agents that point at each other", () => {
    const x = agent({ name: "x" });
    const y = agent({ name: "y", parentId: x.id });
    x.parentId = y.id;
    const fromX = familyOf([x, y], x.id);
    assert.equal(fromX?.root.id, x.id);
    assert.deepEqual(fromX?.members.map((m) => m.agent.id), [y.id]);
    assert.equal(familyOf([x, y], y.id)?.root.id, y.id, "with a cycle the root depends on where you start");
  });

  it("stops at an agent whose parent is missing, which becomes the root", () => {
    const orphan = agent({ name: "orphan", parentId: "gone" });
    const kid = agent({ name: "kid", parentId: orphan.id });
    const family = familyOf([orphan, kid], kid.id);
    assert.equal(family?.root.id, orphan.id);
    assert.deepEqual(family?.members.map((m) => m.agent.id), [kid.id]);
  });
});
