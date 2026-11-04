import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentStatus, ServerEvent } from "../../shared/events.ts";
import { applyEvent, initialState } from "../src/agents.ts";
import { createDemoWorld, demoSnapshot, stepDemo } from "../src/office/demo.ts";
import { STATUSES } from "../src/office/palette.ts";

const T0 = 1_700_000_000_000;

function run(count: number, seed: number, seconds: number) {
  const world = createDemoWorld(count, seed, T0);
  const events: { at: number; event: ServerEvent }[] = [];
  for (let ms = 0; ms <= seconds * 1000; ms += 500) for (const event of stepDemo(world, T0 + ms)) events.push({ at: ms, event });
  return { world, events };
}

describe("demo office", () => {
  it("makes 20 agents: 4 sessions with subagents, one desk each, unique ids, short text", () => {
    const world = createDemoWorld(20, 7, T0);
    const agents = [...world.agents.values()];
    assert.equal(agents.length, 20);
    assert.equal(agents.filter((a) => a.kind === "session").length, 4);
    assert.equal(new Set(agents.map((a) => a.id)).size, 20);
    assert.deepEqual(agents.map((a) => a.desk), Array.from({ length: 20 }, (_, i) => i));
    for (const a of agents) {
      assert.ok(a.name.length <= 200 && a.project.length <= 200 && (a.currentTask?.length ?? 0) <= 200);
      if (a.kind === "subagent") assert.equal(world.agents.get(a.parentId ?? "")?.kind, "session");
      else assert.equal(a.parentId, null);
    }
    assert.ok(agents.some((a) => a.origin === "managed") && agents.some((a) => a.origin === "observed"));
  });

  it("includes a long name and a name that looks like HTML, as plain strings", () => {
    const names = [...createDemoWorld(20, 7, T0).agents.values()].map((a) => a.name);
    assert.ok(names.some((n) => n.length > 25), "a long name to test truncation");
    assert.ok(names.some((n) => n.includes("<img src=x onerror=alert(1)>")), "hostile-looking text to test escaping");
  });

  it("is repeatable: the same seed gives the same events", () => {
    assert.deepEqual(run(20, 7, 60).events, run(20, 7, 60).events);
    assert.notDeepEqual(run(20, 7, 60).events, run(20, 8, 60).events);
  });

  it("changes each agent every 2 to 6 seconds, and does nothing in between", () => {
    const { events } = run(20, 7, 120);
    const times = new Map<string, number[]>();
    for (const { at, event } of events) if (event.type === "agent.status") times.set(event.id, [...(times.get(event.id) ?? []), at]);
    assert.equal(times.size, 20);
    for (const [id, list] of times) {
      for (let i = 1; i < list.length; i++) {
        const gap = (list[i] as number) - (list[i - 1] as number);
        assert.ok(gap >= 2000 && gap <= 6500, `${id}: ${gap} ms`);
      }
    }
    const world = createDemoWorld(5, 3, T0);
    assert.deepEqual(stepDemo(world, T0), [], "nothing is due at the start");
    assert.deepEqual(stepDemo(world, T0 + 1000), [], "or after one second");
  });

  it("shows every status, including waiting and detached, within five minutes", () => {
    const seen = new Set<AgentStatus>();
    for (const a of createDemoWorld(20, 7, T0).agents.values()) seen.add(a.status);
    for (const { event } of run(20, 7, 300).events) if (event.type === "agent.status") seen.add(event.status);
    assert.deepEqual([...seen].sort(), [...STATUSES].sort());
  });

  it("gives a working agent a tool call each time, and keeps at most 50 in its log", () => {
    const { world, events } = run(20, 7, 600);
    const working = events.filter((e) => e.event.type === "agent.status" && e.event.status === "working");
    const activity = events.filter((e) => e.event.type === "agent.activity");
    assert.ok(working.length > 0);
    assert.equal(working.length, activity.length);
    for (const log of world.log.values()) assert.ok(log.length >= 1 && log.length <= 50);
  });

  it("produces events that the page's own state logic understands, ending in the same state", () => {
    const world = createDemoWorld(20, 7, T0);
    let state = applyEvent(initialState, demoSnapshot(world));
    for (let ms = 0; ms <= 120_000; ms += 500) for (const event of stepDemo(world, T0 + ms)) state = applyEvent(state, event);
    for (const a of world.agents.values()) {
      assert.equal(state.agents[a.id]?.status, a.status, a.id);
      assert.equal(state.agents[a.id]?.activity, a.activity, a.id);
    }
  });

  it("keeps the number of agents between 1 and 200", () => {
    assert.equal(createDemoWorld(0, 1, T0).agents.size, 1);
    assert.equal(createDemoWorld(-4, 1, T0).agents.size, 1);
    assert.equal(createDemoWorld(NaN, 1, T0).agents.size, 1);
    assert.equal(createDemoWorld(500, 1, T0).agents.size, 200);
    assert.equal(createDemoWorld(48, 1, T0).agents.size, 48);
  });
});
