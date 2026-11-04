import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerEvent } from "../../shared/events.ts";
import { createRegistry } from "../src/registry.ts";

function setup() {
  let now = 1_000_000;
  const registry = createRegistry({ now: () => now, idleMs: 15_000 });
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  const advance = (ms: number) => {
    now += ms;
    registry.refreshStatuses();
  };
  return { registry, events, advance, now: () => now };
}

const init = { kind: "session" as const, parentId: null, project: "proj", name: "proj", currentTask: null };

describe("agent registry", () => {
  it("announces a new agent once and lists it in the snapshot", () => {
    const { registry, events } = setup();
    registry.upsert("s1", init);
    registry.upsert("s1", init);
    assert.equal(events.filter((e) => e.type === "agent.spawned").length, 1);
    assert.equal(registry.snapshot().length, 1);
    assert.equal(registry.snapshot()[0]?.role, "solo");
  });

  it("is working while a tool call has no result, however long it takes", () => {
    const { registry, advance } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "tool_start", id: "t1", name: "Bash", summary: "Bash Run tests" }, { kind: "event" }], null);
    advance(10 * 60_000);
    assert.equal(registry.get("s1")?.status, "working");
    registry.apply("s1", [{ kind: "tool_end", id: "t1" }, { kind: "event" }], null);
    advance(16_000);
    assert.equal(registry.get("s1")?.status, "idle");
  });

  it("stays working for the idle window after the last event, then goes idle", () => {
    const { registry, events, advance } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "event" }], null);
    advance(10_000);
    assert.equal(registry.get("s1")?.status, "working");
    advance(6_000);
    assert.equal(registry.get("s1")?.status, "idle");
    const before = events.filter((e) => e.type === "agent.status").length;
    advance(6_000);
    assert.equal(events.filter((e) => e.type === "agent.status").length, before, "no repeated status events");
  });

  it("uses the line timestamp, so old history does not look busy", () => {
    const { registry, now } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "event" }], now() - 60_000);
    registry.refreshStatuses();
    assert.equal(registry.get("s1")?.status, "idle");
  });

  it("does not let a timestamp in the future keep an agent working", () => {
    const { registry, advance, now } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "event" }], now() + 3_600_000);
    advance(16_000);
    assert.equal(registry.get("s1")?.status, "idle");
  });

  it("forgets unanswered tool calls on request", () => {
    const { registry } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "tool_start", id: "t1", name: "Read", summary: "Read" }], null);
    registry.clearPending("s1");
    assert.equal(registry.pendingCount("s1"), 0);
  });

  it("emits activity with the tool name and summary, and remembers the latest", () => {
    const { registry, events } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "tool_start", id: "t1", name: "Edit", summary: "Edit app.ts" }], 5);
    const a = events.find((e) => e.type === "agent.activity");
    assert.ok(a && a.type === "agent.activity");
    assert.equal(a.tool, "Edit");
    assert.equal(a.summary, "Edit app.ts");
    assert.equal(registry.get("s1")?.activity, "Edit app.ts");
  });

  it("updates name and task from title and prompt facts", () => {
    const { registry, events } = setup();
    registry.upsert("s1", init);
    registry.apply("s1", [{ kind: "title", text: "Fix login" }, { kind: "prompt", text: "please fix login" }], null);
    assert.equal(registry.get("s1")?.name, "Fix login");
    assert.equal(registry.get("s1")?.currentTask, "please fix login");
    assert.equal(events.filter((e) => e.type === "agent.updated").length, 1);
  });

  it("marks a finished subagent done and nests it under its parent", () => {
    const { registry, events } = setup();
    registry.upsert("s1", init);
    registry.upsert("agent-a", { ...init, kind: "subagent", parentId: "s1", name: "Explore" });
    assert.equal(registry.get("agent-a")?.role, "worker");
    assert.equal(registry.get("agent-a")?.parentId, "s1");
    registry.setFinished("agent-a", true);
    assert.equal(registry.get("agent-a")?.status, "done");
    assert.ok(events.some((e) => e.type === "agent.status" && e.id === "agent-a" && e.status === "done"));
  });

  it("removes an agent and ignores facts for unknown ids", () => {
    const { registry, events } = setup();
    registry.upsert("s1", init);
    registry.remove("s1");
    registry.remove("s1");
    registry.apply("ghost", [{ kind: "event" }], null);
    assert.equal(registry.get("s1"), undefined);
    assert.equal(events.filter((e) => e.type === "agent.removed").length, 1);
  });

  it("caps the number of tool calls it tracks as pending", () => {
    const { registry } = setup();
    registry.upsert("s1", init);
    const many = Array.from({ length: 1000 }, (_, i) => ({ kind: "tool_start" as const, id: `t${i}`, name: "Read", summary: "Read" }));
    registry.apply("s1", many, null);
    assert.ok(registry.pendingCount("s1") <= 200);
  });

  it("gives every agent its own desk, the smallest free number, and frees it when the agent leaves", () => {
    const { registry } = setup();
    for (const id of ["a", "b", "c"]) registry.upsert(id, init);
    assert.deepEqual(["a", "b", "c"].map((id) => registry.get(id)?.desk), [0, 1, 2]);
    registry.remove("b");
    registry.upsert("d", init);
    assert.equal(registry.get("d")?.desk, 1, "the freed desk is reused first");
    registry.upsert("e", init);
    assert.equal(registry.get("e")?.desk, 3);
    assert.equal(registry.get("a")?.desk, 0, "nobody else moves");
    registry.remove("ghost");
    registry.upsert("f", init);
    assert.equal(registry.get("f")?.desk, 4, "removing an unknown agent frees nothing");
  });

  it("keeps desks unique through many arrivals and departures", () => {
    const { registry } = setup();
    let n = 0;
    const live: string[] = [];
    for (let i = 0; i < 300; i++) {
      if (live.length > 0 && i % 3 === 0) registry.remove(live.splice((i * 7) % live.length, 1)[0] ?? "");
      else {
        const taken = new Set(registry.snapshot().map((a) => a.desk));
        let smallestFree = 0;
        while (taken.has(smallestFree)) smallestFree++;
        const id = `s${n++}`;
        registry.upsert(id, init);
        live.push(id);
        assert.equal(registry.get(id)?.desk, smallestFree, "a newcomer takes the smallest free desk");
      }
      const desks = registry.snapshot().map((a) => a.desk);
      assert.equal(new Set(desks).size, desks.length, "no two agents share a desk");
    }
  });

  it("remembers the last 50 tool calls, oldest first, and only for known agents", () => {
    const { registry } = setup();
    registry.upsert("s1", init);
    for (let i = 0; i < 60; i++) {
      registry.apply("s1", [{ kind: "tool_start", id: `t${i}`, name: "Read", summary: `Read file${i}.ts` }], null);
    }
    const log = registry.events("s1");
    assert.ok(log);
    assert.equal(log.length, 50);
    assert.equal(log[0]?.summary, "Read file10.ts");
    assert.equal(log[49]?.summary, "Read file59.ts");
    assert.deepEqual(Object.keys(log[0] ?? {}).sort(), ["summary", "tool", "ts"]);
    assert.equal(registry.events("nobody"), undefined);
    log.length = 0;
    assert.equal(registry.events("s1")?.length, 50, "callers get a copy");
    registry.remove("s1");
    assert.equal(registry.events("s1"), undefined);
  });

  it("stops notifying after unsubscribe", () => {
    const { registry, events } = setup();
    const extra: ServerEvent[] = [];
    const off = registry.subscribe((e) => extra.push(e));
    off();
    registry.upsert("s1", init);
    assert.equal(extra.length, 0);
    assert.ok(events.length > 0);
  });
});
