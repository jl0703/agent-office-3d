import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import { attentionOf, pageTitle, RESEARCH_ID, trackFinished } from "../src/attention.ts";

let n = 0;
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: `a${n++}`,
  kind: "session",
  origin: "managed",
  role: "worker",
  parentId: null,
  name: "worker",
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

describe("what needs attention", () => {
  it("lists errors, caps, waiting and unseen results, most urgent first", () => {
    const err = agent({ name: "b", status: "error", note: "Something broke" });
    const cap = agent({ name: "c", status: "stopped", note: "Stopped: the usage cap for this session was reached." });
    const wait = agent({ name: "d", status: "waiting", note: "Rate limit: try again later" });
    const done = agent({ name: "a", status: "idle" });
    const quiet = agent({ name: "e", status: "working" });
    const stopped = agent({ name: "f", status: "stopped", note: "Stopped by you" });
    const items = attentionOf([quiet, done, wait, cap, err, stopped], new Set([done.id]));
    assert.deepEqual(items.map((i) => [i.kind, i.name]), [["error", "b"], ["cap", "c"], ["waiting", "d"], ["result", "a"]]);
    assert.equal(items[0]?.text, "Something broke");
  });

  it("shortens long text and falls back to a plain word", () => {
    const long = agent({ status: "error", note: "x".repeat(300) });
    const bare = agent({ status: "error" });
    const [a, b] = attentionOf([long, bare], new Set());
    assert.equal(Array.from(a?.text ?? "").length, 91);
    assert.equal(b?.text, "Open it to see what went wrong");
  });

  it("marks a worker started here as finished when it goes from busy to done, until it is opened or works again", () => {
    const w = agent({ status: "working" });
    const before = new Map([[w.id, "working" as const]]);
    const idle = { ...w, status: "idle" as const };
    let unseen = trackFinished(before, [idle], new Set(), null);
    assert.deepEqual([...unseen], [w.id]);
    // Still finished on the next look: stays in the set.
    unseen = trackFinished(new Map([[w.id, "idle" as const]]), [idle], unseen, null);
    assert.deepEqual([...unseen], [w.id]);
    // Opening it clears it.
    assert.deepEqual([...trackFinished(new Map([[w.id, "idle" as const]]), [idle], unseen, w.id)], []);
    // Working again clears it.
    assert.deepEqual([...trackFinished(new Map([[w.id, "idle" as const]]), [{ ...w, status: "working" as const }], unseen, null)], []);
    // An agent that left is forgotten.
    assert.deepEqual([...trackFinished(new Map(), [], unseen, null)], []);
  });

  it("does not mark watched sessions, and does not mark one that was never busy", () => {
    const watched = agent({ origin: "observed", status: "idle" });
    const fresh = agent({ status: "idle" });
    const unseen = trackFinished(new Map([[watched.id, "working" as const]]), [watched, fresh], new Set(), null);
    assert.deepEqual([...unseen], []);
  });

  it("builds the page title with the count and the demo mark", () => {
    assert.equal(pageTitle(0, false), "Agent Office");
    assert.equal(pageTitle(3, false), "(3) Agent Office");
    assert.equal(pageTitle(2, true), "(2) [Demo] Agent Office");
    assert.equal(pageTitle(0, true), "[Demo] Agent Office");
  });

  it("lists a master whose plan waits for an answer, right after errors", () => {
    const plan = { goal: "Add settings", steps: ["a"], files: [], workers: 1, costUsd: 1, risks: "", undo: "", status: "pending" as const };
    const items = attentionOf([agent({ id: "m", role: "master", phase: "planning", plan }), agent({ id: "e", status: "error" })], new Set());
    assert.deepEqual(items.map((i) => i.kind), ["error", "plan"]);
    assert.match(items[1]?.text ?? "", /Plan to approve: Add settings/);
    assert.equal(attentionOf([agent({ role: "master", phase: "planning", plan: { ...plan, status: "approved" } })], new Set()).length, 0);
  });

  it("adds an entry for new research findings, after the agents", () => {
    const err = agent({ status: "error" });
    const items = attentionOf([err], new Set(), 3);
    assert.deepEqual(items.map((i) => [i.id === RESEARCH_ID ? "research" : "agent", i.kind]), [["agent", "error"], ["research", "research"]]);
    assert.equal(items[1]?.text, "3 new findings to judge");
    assert.equal(attentionOf([], new Set(), 1)[0]?.text, "1 new finding to judge");
    assert.equal(attentionOf([], new Set(), 0).length, 0);
  });
});
