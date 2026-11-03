import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import { applyEvent, buildTree, initialState } from "../src/agents.ts";

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  kind: "session",
  origin: "observed",
  role: "solo",
  parentId: null,
  name: id,
  project: "demo",
  status: "idle",
  currentTask: null,
  tool: null,
  activity: null,
  updatedAt: "2026-11-03T10:00:00.000Z",
  ...extra,
});

describe("agent list state", () => {
  it("replaces everything on a snapshot", () => {
    const first = applyEvent(initialState, { type: "snapshot", agents: [agent("a"), agent("b")] });
    const second = applyEvent(first, { type: "snapshot", agents: [agent("c")] });
    assert.deepEqual(Object.keys(second.agents), ["c"]);
  });

  it("adds, updates, and removes agents", () => {
    let s = applyEvent(initialState, { type: "agent.spawned", agent: agent("a") });
    s = applyEvent(s, { type: "agent.updated", agent: agent("a", { name: "Fix login" }) });
    assert.equal(s.agents["a"]?.name, "Fix login");
    s = applyEvent(s, { type: "agent.removed", id: "a" });
    assert.deepEqual(s.agents, {});
  });

  it("applies status and activity to the right agent without changing the input", () => {
    const s0 = applyEvent(initialState, { type: "snapshot", agents: [agent("a"), agent("b")] });
    const s1 = applyEvent(s0, { type: "agent.status", id: "a", status: "working" });
    const s2 = applyEvent(s1, { type: "agent.activity", id: "a", tool: "Edit", summary: "Edit app.ts", ts: "2026-11-03T10:05:00.000Z" });
    assert.equal(s2.agents["a"]?.status, "working");
    assert.equal(s2.agents["a"]?.tool, "Edit");
    assert.equal(s2.agents["a"]?.activity, "Edit app.ts");
    assert.equal(s2.agents["a"]?.updatedAt, "2026-11-03T10:05:00.000Z");
    assert.equal(s2.agents["b"]?.status, "idle");
    assert.equal(s0.agents["a"]?.status, "idle", "earlier state is untouched");
  });

  it("ignores events for agents it does not know", () => {
    const s = applyEvent(initialState, { type: "agent.status", id: "ghost", status: "working" });
    assert.deepEqual(s.agents, {});
    assert.equal(applyEvent(s, { type: "agent.activity", id: "ghost", tool: "X", summary: "X", ts: "t" }), s);
    assert.equal(applyEvent(s, { type: "agent.removed", id: "ghost" }).agents["ghost"], undefined);
  });
});

describe("agent tree", () => {
  const state = (...agents: Agent[]) => applyEvent(initialState, { type: "snapshot", agents });

  it("puts subagents under their parent session", () => {
    const tree = buildTree(
      state(
        agent("s1", { name: "Alpha" }),
        agent("agent-1", { kind: "subagent", role: "worker", parentId: "s1", name: "Explore" }),
        agent("agent-2", { kind: "subagent", role: "worker", parentId: "s1", name: "Review" }),
      ),
    );
    assert.equal(tree.length, 1);
    assert.deepEqual(tree[0]?.children.map((c) => c.agent.name), ["Explore", "Review"]);
  });

  it("shows a subagent at the top level when its parent is not listed", () => {
    const tree = buildTree(state(agent("agent-1", { kind: "subagent", role: "worker", parentId: "gone" })));
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.agent.id, "agent-1");
  });

  it("keeps a steady order that does not depend on status", () => {
    const a = agent("a", { name: "Beta", project: "p" });
    const b = agent("b", { name: "Alpha", project: "p" });
    const order = (x: Agent, y: Agent) => buildTree(state(x, y)).map((n) => n.agent.id);
    assert.deepEqual(order(a, b), ["b", "a"]);
    assert.deepEqual(order({ ...a, status: "working" }, b), ["b", "a"]);
  });

  it("does not lose agents that point at each other", () => {
    const tree = buildTree(state(agent("x", { parentId: "y" }), agent("y", { parentId: "x" })));
    const ids = new Set<string>();
    const walk = (nodes: typeof tree) => nodes.forEach((n) => (ids.add(n.agent.id), walk(n.children)));
    walk(tree);
    assert.deepEqual([...ids].sort(), ["x", "y"]);
  });
});
