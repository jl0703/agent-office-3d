import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import type { TreeNode } from "../src/agents.ts";
import { countByStatus, filterTree, isFiltering, matches, noFilter, step } from "../src/filter.ts";

let n = 0;
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: `f${n++}`,
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
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const node = (a: Agent, children: TreeNode[] = []): TreeNode => ({ agent: a, children });

describe("matching", () => {
  it("matches every word, anywhere in name, project, task, tool or activity, ignoring case", () => {
    const a = agent({ name: "Docs writer", project: "Infra", currentTask: "Update the API docs", tool: "Edit", activity: "invoice.ts" });
    const f = (query: string) => matches(a, { query, statuses: new Set() });
    assert.equal(f(""), true);
    assert.equal(f("  "), true);
    assert.equal(f("docs"), true);
    assert.equal(f("INFRA invoice"), true);
    assert.equal(f("api edit"), true);
    assert.equal(f("docs missing"), false);
    assert.equal(f("zzz"), false);
  });

  it("filters by status, alone and with words", () => {
    const a = agent({ name: "x", status: "error" });
    assert.equal(matches(a, { query: "", statuses: new Set(["error", "waiting"]) }), true);
    assert.equal(matches(a, { query: "", statuses: new Set(["working"]) }), false);
    assert.equal(matches(a, { query: "x", statuses: new Set(["working"]) }), false);
    assert.equal(matches(a, { query: "x", statuses: new Set(["error"]) }), true);
  });

  it("knows when it is filtering", () => {
    assert.equal(isFiltering(noFilter), false);
    assert.equal(isFiltering({ query: " ", statuses: new Set() }), false);
    assert.equal(isFiltering({ query: "a", statuses: new Set() }), true);
    assert.equal(isFiltering({ query: "", statuses: new Set(["done"]) }), true);
  });
});

describe("filtering the tree", () => {
  it("keeps matches and the parents of matches, drops the rest, and returns everything when not filtering", () => {
    const kidA = agent({ name: "alpha" });
    const kidB = agent({ name: "beta" });
    const lead = agent({ name: "lead" });
    const other = agent({ name: "other" });
    const tree = [node(lead, [node(kidA), node(kidB)]), node(other)];
    assert.equal(filterTree(tree, noFilter).length, 2);
    const result = filterTree(tree, { query: "alpha", statuses: new Set() });
    assert.deepEqual(result.map((r) => [r.agent.name, r.children.map((c) => c.agent.name)]), [["lead", ["alpha"]]]);
    assert.deepEqual(filterTree(tree, { query: "nothing", statuses: new Set() }), []);
    // A matching parent is kept even when no child matches.
    const parentOnly = filterTree(tree, { query: "lead", statuses: new Set() });
    assert.deepEqual(parentOnly.map((r) => [r.agent.name, r.children.length]), [["lead", 0]]);
  });
});

describe("counts and stepping", () => {
  it("counts the statuses that occur, in the given order", () => {
    const list = [agent({ status: "error" }), agent({ status: "working" }), agent({ status: "working" })];
    assert.deepEqual(countByStatus(list, ["working", "idle", "error"]), [{ status: "working", count: 2 }, { status: "error", count: 1 }]);
    assert.deepEqual(countByStatus([], ["working"]), []);
    assert.deepEqual(countByStatus(list, ["working", "idle", "error"], new Set(["idle"])), [{ status: "working", count: 2 }, { status: "idle", count: 0 }, { status: "error", count: 1 }], "a chosen status stays, even with none");
  });

  it("steps to the next or previous item, wrapping, and starts at an end when nothing is current", () => {
    const items = ["a", "b", "c"];
    assert.equal(step(items, "a", 1), "b");
    assert.equal(step(items, "c", 1), "a");
    assert.equal(step(items, "a", -1), "c");
    assert.equal(step(items, undefined, 1), "a");
    assert.equal(step(items, undefined, -1), "c");
    assert.equal(step(items, "gone", 1), "a");
    assert.equal(step([], "a", 1), null);
  });
});
