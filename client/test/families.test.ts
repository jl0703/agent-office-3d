import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import { familyIndexes, rootOf } from "../src/office/families.ts";

const agent = (id: string, desk: number, parentId: string | null = null): Agent => ({
  id,
  kind: parentId ? "subagent" : "session",
  origin: "observed",
  role: parentId ? "worker" : "solo",
  parentId,
  name: id,
  project: "p",
  status: "idle",
  currentTask: null,
  tool: null,
  activity: null,
  desk,
  updatedAt: "2026-11-04T10:00:00.000Z",
});

describe("agent families", () => {
  it("puts a session and its subagents in one family and different sessions in different ones", () => {
    const f = familyIndexes([agent("s1", 0), agent("a", 1, "s1"), agent("b", 2, "s1"), agent("s2", 3), agent("c", 4, "s2")]);
    assert.equal(f.get("a"), f.get("s1"));
    assert.equal(f.get("b"), f.get("s1"));
    assert.equal(f.get("c"), f.get("s2"));
    assert.notEqual(f.get("s1"), f.get("s2"));
  });

  it("numbers families by the desk of their top session, so the order is steady", () => {
    const f = familyIndexes([agent("late", 9), agent("early", 2), agent("mid", 5)]);
    assert.deepEqual([f.get("early"), f.get("mid"), f.get("late")], [0, 1, 2]);
  });

  it("wraps around after six families", () => {
    const f = familyIndexes(Array.from({ length: 8 }, (_, i) => agent(`s${i}`, i)));
    assert.equal(f.get("s6"), 0);
    assert.equal(f.get("s7"), 1);
    assert.equal(new Set([...f.values()]).size, 6);
  });

  it("treats a subagent whose parent is not listed as the top of its own family", () => {
    const f = familyIndexes([agent("orphan", 0, "gone"), agent("child", 1, "orphan")]);
    assert.equal(f.get("child"), f.get("orphan"));
    const lookup = new Map([["orphan", agent("orphan", 0, "gone")]]);
    assert.equal(rootOf(agent("orphan", 0, "gone"), lookup).id, "orphan");
  });

  it("copes with agents that point at each other and with an empty list", () => {
    const f = familyIndexes([agent("x", 0, "y"), agent("y", 1, "x")]);
    assert.equal(f.size, 2);
    assert.ok([...f.values()].every((v) => v >= 0 && v < 6));
    assert.equal(familyIndexes([]).size, 0);
  });
});
