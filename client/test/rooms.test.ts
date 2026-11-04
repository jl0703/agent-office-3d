import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import {
  HUB_RADIUS,
  MAX_ROOMS,
  ROOM_COLORS,
  SEATS_PER_ROOM,
  SEAT_COUNT,
  assignRooms,
  emptyAssignment,
  overviewBounds,
  roadSegment,
  roomBounds,
  roomName,
  roomRect,
  seatPosition,
  type Assignment,
} from "../src/office/rooms.ts";

let counter = 0;
const agent = (project: string, over: Partial<Agent> = {}): Agent => ({
  id: `a${counter++}`,
  kind: "session",
  origin: "observed",
  role: "solo",
  parentId: null,
  name: `agent ${counter}`,
  project,
  status: "working",
  currentTask: null,
  tool: null,
  activity: null,
  desk: 0,
  note: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const roomIdOf = (a: Assignment, id: string) => Math.floor((a.seat.get(id) as number) / SEATS_PER_ROOM);

describe("room assignment", () => {
  it("puts agents of one project in one room and other projects in other rooms", () => {
    const [a, b, c] = [agent("web"), agent("web"), agent("docs")] as [Agent, Agent, Agent];
    const r = assignRooms(emptyAssignment, [a, b, c]);
    assert.equal(roomIdOf(r, a.id), roomIdOf(r, b.id));
    assert.notEqual(roomIdOf(r, a.id), roomIdOf(r, c.id));
    assert.equal(r.unseated, 0);
    assert.equal(new Set(r.seat.values()).size, 3, "every seat is its own");
  });

  it("opens a second room for a project when the first is full, and never loses an agent", () => {
    const many = Array.from({ length: 8 }, () => agent("web"));
    const r = assignRooms(emptyAssignment, many);
    const rooms = new Set(many.map((m) => r.roomOf.get(m.id)));
    assert.equal(rooms.size, 2);
    assert.deepEqual([...rooms].map((k) => roomName(k as string)).sort(), ["web", "web 2"]);
    assert.equal(r.seat.size, 8);
  });

  it("keeps everyone in place when others leave or arrive", () => {
    const first = [agent("web"), agent("web"), agent("docs"), agent("infra")] as [Agent, Agent, Agent, Agent];
    const r1 = assignRooms(emptyAssignment, first);
    const r2 = assignRooms(r1, [first[0], first[3], agent("docs")]);
    assert.equal(r2.seat.get(first[0].id), r1.seat.get(first[0].id));
    assert.equal(r2.seat.get(first[3].id), r1.seat.get(first[3].id));
    const r3 = assignRooms(r2, [first[0], first[3], agent("web")]);
    assert.equal(r3.seat.get(first[0].id), r1.seat.get(first[0].id));
    assert.equal(roomIdOf(r3, first[0].id), roomIdOf(r1, first[0].id));
  });

  it("frees a room's place on the ring when its last agent leaves, and a new project takes it", () => {
    const a = agent("one");
    const b = agent("two");
    const r1 = assignRooms(emptyAssignment, [a, b]);
    const freed = roomIdOf(r1, a.id);
    const c = agent("three");
    const r2 = assignRooms(r1, [b, c]);
    assert.equal(roomIdOf(r2, c.id), freed);
    assert.equal(r2.roomSlot.size, 2);
  });

  it("seats a subagent in its parent's room while there is space", () => {
    const parent = agent("web");
    const filler = agent("web");
    const child = agent("other-name-same-folder", { parentId: parent.id, kind: "subagent" });
    const r = assignRooms(emptyAssignment, [parent, filler, child]);
    assert.equal(roomIdOf(r, child.id), roomIdOf(r, parent.id));
  });

  it("leaves agents unseated, counted, when all eight rooms are full", () => {
    const projects = Array.from({ length: MAX_ROOMS + 2 }, (_, i) => agent(`p${i}`));
    const r = assignRooms(emptyAssignment, projects);
    assert.equal(r.roomSlot.size, MAX_ROOMS);
    assert.equal(r.unseated, 2);
    assert.equal(r.seat.size, MAX_ROOMS);
  });

  it("gives the same answer for the same input regardless of order", () => {
    const list = [agent("x"), agent("y"), agent("x"), agent("z")];
    const forward = assignRooms(emptyAssignment, list);
    const backward = assignRooms(emptyAssignment, [...list].reverse());
    for (const a of list) assert.equal(forward.seat.get(a.id), backward.seat.get(a.id));
  });

  it("names rooms after the project, with a number from the second on", () => {
    assert.equal(roomName("web\u00011"), "web");
    assert.equal(roomName("web\u00012"), "web 2");
  });
});

describe("room layout", () => {
  it("never overlaps two rooms, or a room and the hub", () => {
    for (let i = 0; i < MAX_ROOMS; i++) {
      const a = roomRect(i);
      for (let j = i + 1; j < MAX_ROOMS; j++) {
        const b = roomRect(j);
        const apart = a.maxX + 0.5 < b.minX || b.maxX + 0.5 < a.minX || a.maxZ + 0.5 < b.minZ || b.maxZ + 0.5 < a.minZ;
        assert.ok(apart, `rooms ${i} and ${j}`);
      }
      const nearestX = Math.max(a.minX, Math.min(0, a.maxX));
      const nearestZ = Math.max(a.minZ, Math.min(0, a.maxZ));
      assert.ok(Math.hypot(nearestX, nearestZ) > HUB_RADIUS + 1, `room ${i} clear of the hub`);
    }
  });

  it("puts every seat inside its own room and gives each seat its own place", () => {
    const seen = new Set<string>();
    for (let s = 0; s < SEAT_COUNT; s++) {
      const p = seatPosition(s);
      const r = roomRect(Math.floor(s / SEATS_PER_ROOM));
      assert.ok(p.x > r.minX + 1 && p.x < r.maxX - 1 && p.z > r.minZ + 1 && p.z < r.maxZ - 1, `seat ${s}`);
      seen.add(`${p.x.toFixed(2)},${p.z.toFixed(2)}`);
    }
    assert.equal(seen.size, SEAT_COUNT);
  });

  it("refuses a seat or room that cannot exist", () => {
    for (const bad of [-1, 1.5, NaN, SEAT_COUNT]) assert.throws(() => seatPosition(bad), RangeError, String(bad));
    assert.throws(() => roomRect(MAX_ROOMS), RangeError);
  });

  it("frames the hub alone, grows with more rooms, and frames one room tighter than all", () => {
    const none = overviewBounds([]);
    const some = overviewBounds([0, 1]);
    const all = overviewBounds([0, 1, 2, 3, 4, 5, 6, 7]);
    const width = (b: { minX: number; maxX: number }) => b.maxX - b.minX;
    assert.ok(width(none) < width(some) && width(some) <= width(all));
    assert.ok(width(roomBounds(0)) < width(all));
  });

  it("draws a road of positive length from the hub to each room", () => {
    for (let i = 0; i < MAX_ROOMS; i++) {
      const road = roadSegment(i);
      assert.ok(road.length > 1, `room ${i}`);
      assert.ok(Number.isFinite(road.x) && Number.isFinite(road.z) && Number.isFinite(road.angle));
    }
  });

  it("gives rooms of one project one colour, different projects different colours, and keeps them", () => {
    const list = [agent("web"), agent("web"), agent("docs"), agent("infra"), ...Array.from({ length: 6 }, () => agent("web"))];
    const r = assignRooms(emptyAssignment, list);
    const colourOfProject = (project: string) => new Set([...r.roomSlot.keys()].filter((k) => roomName(k).startsWith(project)).map((k) => r.colorOf.get(k)));
    assert.equal(colourOfProject("web").size, 1);
    const projects = ["web", "docs", "infra"];
    const colours = projects.map((p) => [...colourOfProject(p)][0]);
    assert.equal(new Set(colours).size, 3, "web, docs and infra differ");
    const again = assignRooms(r, list);
    for (const k of r.roomSlot.keys()) assert.equal(again.colorOf.get(k), r.colorOf.get(k));
    assert.ok([...r.colorOf.values()].every((c) => c >= 0 && c < ROOM_COLORS.length));
  });
});
