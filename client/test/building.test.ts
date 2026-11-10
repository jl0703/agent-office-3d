import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/events.ts";
import { BUILDING_RECT, CORRIDOR_RECT, SPINE_RECT, buildingFor, emptyPlacement, ENTRANCE, inside, kindOfDepartment, LOBBY_RECT, MAX_DEPARTMENTS, placeAgents, seatPoint, SEAT_COUNT, VISITORS_KEY, VISITOR_SEATS, MANAGEMENT_KEY, deptKey, type Building, type Placement } from "../src/office/building.ts";
import { SEATS_PER_ROOM, seatsOfRoom } from "../src/office/building.ts";
import type { Person } from "../src/team.ts";

let n = 0;
const id12 = (i: number) => i.toString(16).padStart(12, "0");
const SOMEONE = id12(0xfff); // anyone but the top of the team
const person = (name: string, department: string | undefined, reportsTo: string | null = SOMEONE): Person => ({ id: id12(++n), name, role: "Role", brief: "", reportsTo, ...(department ? { department } : {}) });
const agent = (name: string, over: Partial<Agent> = {}): Agent => ({ id: `a-${name}`, kind: "session", origin: "managed", role: "worker", parentId: null, name, project: "web", status: "working", currentTask: null, tool: null, activity: null, desk: 0, updatedAt: "2026-11-10T00:00:00Z", note: null, ...over });
const asPerson = (p: Person, name = p.name) => agent(name, { personId: p.id });

const ceo = person("Alex", "Management", null);
const lead = person("Zed", "Engineering", ceo.id);
const dev1 = person("Riley", "Engineering", lead.id);
const dev2 = person("Casey", "Engineering", lead.id);
const qa = person("Morgan", "Quality", lead.id);
const team = [ceo, lead, dev1, dev2, qa];

const round = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
const overlap = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: typeof a) => a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9;
const allDepartments = (count: number) => Array.from({ length: count }, (_, i) => person(`P${i}`, `Dept ${i}`));

describe("the building: the floor plan", () => {
  it("fits every room inside the building without overlaps, with the doors on the room's edge and every desk inside its room", () => {
    const b = buildingFor(allDepartments(MAX_DEPARTMENTS));
    assert.equal(b.rooms.length, 4 + MAX_DEPARTMENTS + 1, "management, meeting room, pantry, lounge, six departments, visitors");
    for (const room of b.rooms) {
      assert.ok(room.rect.minX >= BUILDING_RECT.minX && room.rect.maxX <= BUILDING_RECT.maxX && room.rect.minZ >= BUILDING_RECT.minZ && room.rect.maxZ <= BUILDING_RECT.maxZ, `${room.key} is inside the building`);
      for (const d of room.desks) assert.ok(inside(room.rect, d), `${room.key}: a desk is inside its room`);
      const onEdge = room.door.z === room.rect.minZ || room.door.z === room.rect.maxZ;
      assert.ok(onEdge && room.door.x >= room.rect.minX && room.door.x <= room.rect.maxX, `${room.key}: the door is on the room's edge`);
    }
    for (let i = 0; i < b.rooms.length; i++) for (let j = i + 1; j < b.rooms.length; j++) assert.equal(overlap(b.rooms[i]!.rect, b.rooms[j]!.rect), false, `${b.rooms[i]!.key} and ${b.rooms[j]!.key} do not overlap`);
    assert.deepEqual(ENTRANCE, { x: 0, z: BUILDING_RECT.maxZ }, "the entrance is in the middle of the near wall");
    // The doors open onto the corridor: a room north of it by its near edge, a room south of it by its far edge.
    for (const room of b.rooms.filter((r) => r.kind !== "visitors")) {
      assert.equal(room.door.z, room.rect.maxZ <= CORRIDOR_RECT.minZ + 1e-9 ? CORRIDOR_RECT.minZ : CORRIDOR_RECT.maxZ, `${room.key}: the door is on the corridor`);
      assert.ok(room.door.x > room.rect.minX && room.door.x < room.rect.maxX, `${room.key}: the door is within the room's width`);
    }
    // The exact plan, so a slip in one number is seen: 43 wide (two rooms each side of the spine and a wing of one more), the corridor 3 deep between the rows, the spine 3 wide.
    assert.deepEqual(round(BUILDING_RECT), { minX: -17.5, maxX: 25.5, minZ: -11.4, maxZ: 15.6 });
    assert.deepEqual(round(CORRIDOR_RECT), { minX: -17.5, maxX: 25.5, minZ: -4.2, maxZ: -1.2 });
    assert.deepEqual(round(SPINE_RECT), { minX: -1.5, maxX: 1.5, minZ: -11.4, maxZ: 6 });
    assert.deepEqual(round(b.rooms.find((r) => r.slot === 1)!.rect), { minX: -9.5, maxX: -1.5, minZ: -1.2, maxZ: 6 });
    assert.equal(b.rooms.find((r) => r.key === VISITORS_KEY)?.desks.length, VISITOR_SEATS);
  });

  it("puts the Meeting room beside Management and the Pantry and the Lounge in the wing, none of them with a desk", () => {
    const b = buildingFor([]);
    const rect = (key: string) => round(b.rooms.find((r) => r.key === key)!.rect);
    assert.deepEqual(rect("meeting"), { minX: -9.5, maxX: -1.5, minZ: -11.4, maxZ: -4.2 });
    assert.deepEqual(rect("pantry"), { minX: 17.5, maxX: 25.5, minZ: -11.4, maxZ: -4.2 });
    assert.deepEqual(rect("lounge"), { minX: 17.5, maxX: 25.5, minZ: -1.2, maxZ: 6 });
    for (const key of ["meeting", "pantry", "lounge"]) {
      const room = b.rooms.find((r) => r.key === key)!;
      assert.equal(room.desks.length, 0, `${key} holds no desks`);
      assert.equal(seatsOfRoom(b, key).length, 0);
    }
    assert.equal(b.rooms.some((r) => r.key === "library"), false, "the Library is gone");
    assert.ok(buildingFor(allDepartments(MAX_DEPARTMENTS)).rooms.filter((r) => r.desks.length === 0).length === 3, "the same three shared rooms however many departments");
  });

  it("numbers the desks without gaps or repeats, and finds each desk's place from its number", () => {
    const b = buildingFor(allDepartments(MAX_DEPARTMENTS));
    const points = Array.from({ length: SEAT_COUNT }, (_, s) => seatPoint(b, s));
    assert.ok(points.every((p) => p !== undefined), "every number has a place");
    assert.equal(new Set(points.map((p) => `${p!.x},${p!.z}`)).size, SEAT_COUNT, "no two desks are in one place");
    assert.equal(seatPoint(b, SEAT_COUNT), undefined);
    assert.equal(seatPoint(b, -1), undefined);
    const fewer = buildingFor([ceo]);
    assert.equal(seatPoint(fewer, SEATS_PER_ROOM), undefined, "a department that has no room has no desks");
  });

  it("looks at the lobby as one open area with the walkway down the middle kept free", () => {
    const b = buildingFor([]);
    const lobby = b.rooms.find((r) => r.key === VISITORS_KEY)!;
    assert.deepEqual(lobby.rect, LOBBY_RECT);
    assert.ok(lobby.desks.every((d) => Math.abs(d.x) > 3), "no desk in the walkway");
  });
});

describe("the building: departments and their rooms", () => {
  it("picks a room's look from the department's name", () => {
    const table: [string, string][] = [["Engineering", "engineering"], ["Software Development", "engineering"], ["QA", "qa"], ["Quality Assurance", "qa"], ["Testing", "qa"], ["Design", "design"], ["UX", "design"], ["Product", "product"], ["Operations", "operations"], ["Customer Support", "operations"], ["Management", "management"], ["Executive", "management"], ["Marketing", "general"], ["", "general"]];
    for (const [name, kind] of table) assert.equal(kindOfDepartment(name), kind, name);
    // Only a whole name means the executives; words that merely contain a keyword do not.
    const notWhatTheyLookLike: [string, string][] = [["Product Management", "product"], ["Project Management", "general"], ["Account Management", "general"], ["Directory", "general"], ["Latest", "general"], ["Luxury", "general"], ["Barcode", "general"], ["Software Testing", "qa"]];
    for (const [name, kind] of notWhatTheyLookLike) assert.equal(kindOfDepartment(name), kind, name);
  });

  it("gives each department a place in order, keeps a place while the department exists, and refills a freed place", () => {
    const first = buildingFor(team);
    assert.deepEqual([...first.slotOf], [[deptKey("Engineering"), 0], [deptKey("Quality"), 1]]);
    const names = (b: Building) => b.rooms.filter((r) => r.slot !== undefined).map((r) => `${r.slot}:${r.name}`);
    assert.deepEqual(names(first), ["0:Engineering", "1:Quality"]);
    const later = buildingFor([...team, person("Dee", "Design")], first.slotOf);
    assert.deepEqual(names(later), ["0:Engineering", "1:Quality", "2:Design"]);
    const without = buildingFor(team.filter((p) => p.department !== "Engineering").concat(person("Dee", "Design")), later.slotOf);
    assert.equal(without.slotOf.get(deptKey("Quality")), 1, "Quality did not move");
    assert.equal(without.slotOf.get(deptKey("Design")), 2, "Design kept its place");
    const refill = buildingFor([...team.filter((p) => p.department !== "Engineering"), person("Ops", "Operations")], later.slotOf);
    assert.equal(refill.slotOf.get(deptKey("Operations")), 0, "a new department takes the freed place");
  });

  it("makes six rooms at most, treats a management department as the Management office, and names a room as it was first written", () => {
    const b = buildingFor(allDepartments(8));
    assert.equal(b.slotOf.size, MAX_DEPARTMENTS);
    assert.equal(b.slotOf.has(deptKey("Dept 6")), false, "the seventh has no room");
    const same = buildingFor([person("A", "Engineering", ceo.id), person("B", " engineering ", ceo.id), person("C", "Leadership", ceo.id), person("D", "Quality  Assurance", ceo.id), person("E", "quality assurance", ceo.id)]);
    assert.equal(same.rooms.filter((r) => r.slot !== undefined).length, 2, "Engineering, and Quality Assurance however its spaces are typed");

    assert.equal(same.rooms.find((r) => r.slot !== undefined)?.name, "Engineering");
    const alone = buildingFor([person("Chief", "Operations", null)]);
    assert.equal(alone.rooms.some((r) => r.slot !== undefined), false, "the person at the top does not make a room of their department");
    assert.equal(same.rooms.some((r) => r.name === "Leadership"), false, "Leadership shares the Management office");
  });
});

describe("the building: who sits where", () => {
  const building = buildingFor(team);
  const place = (agents: Agent[], previous: Placement = emptyPlacement, b = building) => placeAgents(b, previous, agents, team);
  const roomName = (b: Building, key: string) => b.rooms.find((r) => r.key === key)?.name;

  it("puts a person in their department's room, the person at the top in Management, and an agent with no role in Visitors", () => {
    const p = place([asPerson(dev1), asPerson(qa), asPerson(ceo), agent("Loner")]);
    assert.equal(roomName(building, p.roomOf.get("a-Riley")!), "Engineering");
    assert.equal(roomName(building, p.roomOf.get("a-Morgan")!), "Quality");
    assert.equal(p.roomOf.get("a-Alex"), MANAGEMENT_KEY);
    assert.equal(p.roomOf.get("a-Loner"), VISITORS_KEY);
    assert.equal(new Set(p.seat.values()).size, 4, "everyone has their own desk");
    for (const [agentId, seat] of p.seat) assert.ok(seatPoint(building, seat), `${agentId} has a real desk`);
  });

  it("sends a person whose department has no room to Visitors, and puts a lead at the first desk of a room", () => {
    const stray = person("Zed", "Marketing", ceo.id);
    const crowded = buildingFor([...team, ...allDepartments(MAX_DEPARTMENTS)]);
    const p = placeAgents(crowded, emptyPlacement, [asPerson(stray)], [...team, ...allDepartments(MAX_DEPARTMENTS), stray]);
    assert.equal(p.roomOf.get("a-Zed"), VISITORS_KEY, "no sixth-and-seventh room");
    const q = place([asPerson(dev1), asPerson(dev2), asPerson(lead)]);
    const base = Math.min(...[...q.seat.values()]);
    assert.equal(q.seat.get("a-Zed"), base, "the lead has the first desk although listed and named last");
  });

  it("seats a subagent's own subagents in the same room, wherever they come in the list", () => {
    const parent = asPerson(dev1);
    const child = agent("child", { parentId: parent.id });
    const grandchild = agent("grandchild", { parentId: child.id });
    const p = place([grandchild, child, parent]);
    assert.equal(p.roomOf.get("a-grandchild"), p.roomOf.get(parent.id));
    assert.equal(p.roomOf.get("a-child"), p.roomOf.get(parent.id));
  });

  it("lets a subagent join its parent's room, and falls back to the next room when one is full", () => {
    const parent = asPerson(dev1);
    const child = agent("helper", { parentId: parent.id });
    const p = place([parent, child]);
    assert.equal(p.roomOf.get("a-helper"), p.roomOf.get(parent.id));
    const many = Array.from({ length: SEATS_PER_ROOM + 2 }, (_, i) => agent(`E${i}`, { personId: dev1.id }));
    const q = place(many);
    assert.equal([...q.roomOf.values()].filter((k) => k === deptKey("Engineering")).length, SEATS_PER_ROOM, "the room holds six");
    assert.equal([...q.roomOf.values()].filter((k) => k === VISITORS_KEY).length, 2, "the rest wait in Visitors");
    assert.equal(q.unseated, 0);
  });

  it("keeps everyone's desk while others come and go, and leaves agents unseated when every desk is taken", () => {
    const a = asPerson(dev1);
    const b = asPerson(qa);
    const first = place([a, b]);
    const second = place([agent("New"), b, a, asPerson(dev2)], first);
    assert.equal(second.seat.get(a.id), first.seat.get(a.id));
    assert.equal(second.seat.get(b.id), first.seat.get(b.id));
    const third = place([a], second);
    assert.equal(third.seat.get(a.id), first.seat.get(a.id), "still there after the others left");
    const crowd = Array.from({ length: VISITOR_SEATS + 5 }, (_, i) => agent(`V${String(i).padStart(2, "0")}`));
    const p = place(crowd);
    assert.equal(p.seat.size, VISITOR_SEATS);
    assert.equal(p.unseated, 5);
  });

  it("does not move an agent that was sent to Visitors when its room later has room", () => {
    const many = Array.from({ length: SEATS_PER_ROOM + 1 }, (_, i) => agent(`E${i}`, { personId: dev1.id }));
    const first = place(many);
    const overflow = many.find((m) => first.roomOf.get(m.id) === VISITORS_KEY)!;
    const second = place(many.filter((m) => m.id === overflow.id || m.id === "a-E0"), first);
    assert.equal(second.roomOf.get(overflow.id), VISITORS_KEY);
    assert.equal(second.seat.get(overflow.id), first.seat.get(overflow.id));
  });
});
