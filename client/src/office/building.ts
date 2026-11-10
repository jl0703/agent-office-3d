// The office building: one floor with a corridor, a Management office, a Library (the knowledge hub), up to six department
// rooms and an open-plan Visitors area. Everything here is plain arithmetic, so it can be tested without drawing anything.
//
//   z grows toward the camera (the entrance is at the near end); x grows to the right.
//
//        x: -17.5      -9.5      -1.5   1.5       9.5      17.5
//   north   | Management | Library |  s  | slot 0  | slot 3 |        z -11.4 .. -4.2
//   corridor|==========================================|             z  -4.2 .. -1.2
//   south   | slot 4     | slot 1  |  p  | slot 2  | slot 5 |        z  -1.2 ..  6.0
//   lobby   |   Visitors (open plan, 24 desks)         |            z   6.0 .. 15.6   entrance at x = 0
//
// ("s" and "p" are the spine, 3 wide, that joins the corridor to the Library side and the lobby.)
import type { Agent } from "../../../shared/events.ts";
import { roleOf, type Person } from "../team.ts";
import { ROOM_COLORS, SEATS_PER_ROOM, type Bounds } from "./rooms.ts";

export type { Bounds };
export type Point = { x: number; z: number };

export const ROOM_W = 8;
export const ROOM_D = 7.2;
export const SPINE_W = 3;
export const CORRIDOR_D = 3;
export const LOBBY_D = 9.6;
export const MAX_DEPARTMENTS = 6;

const NORTH = { minZ: -(ROOM_D + CORRIDOR_D + 1.2), maxZ: -(CORRIDOR_D + 1.2) }; // -11.4 .. -4.2
const CORRIDOR = { minZ: -(CORRIDOR_D + 1.2), maxZ: -1.2 };
const SOUTH = { minZ: -1.2, maxZ: -1.2 + ROOM_D };
const LOBBY = { minZ: SOUTH.maxZ, maxZ: SOUTH.maxZ + LOBBY_D };
const HALF = (ROOM_W * 4 + SPINE_W) / 2; // 17.5: the outer wall (two rooms each side of the spine)
const INNER = SPINE_W / 2; // 1.5: the spine's edge

export type RoomKind = "management" | "library" | "engineering" | "qa" | "design" | "product" | "operations" | "general" | "visitors";

/** What a department's room looks like, from its name. A name that matches none gets the plain General look. */
export function kindOfDepartment(name: string): RoomKind {
  const n = name.toLowerCase();
  // The Management office is for a department with exactly such a name: "Product Management" is a product team, not the executives.
  if (/^(management|executive|executives|leadership|directors?)$/.test(n.trim())) return "management";
  if (/\b(qa|quality|test)/.test(n)) return "qa";
  if (/\b(engineer|develop|software|backend|frontend|platform|code)/.test(n)) return "engineering";
  if (/\b(design|ux|ui|creative)/.test(n)) return "design";
  if (/\b(product|pm|roadmap)/.test(n)) return "product";
  if (/\b(operat|support|devops|infra|ops|help)/.test(n)) return "operations";
  return "general";
}

export type RoomSpec = {
  key: string;
  name: string;
  kind: RoomKind;
  rect: Bounds;
  /** Where the room opens onto a corridor (or, for the lobby, the entrance on the near wall). */
  door: Point;
  /** The desks, in seat order; the first is the lead's. */
  desks: Point[];
  /** An index into ROOM_COLORS. */
  color: number;
  /** For a department room, its place 0 to MAX_DEPARTMENTS - 1. */
  slot?: number;
};

const rect = (minX: number, maxX: number, z: { minZ: number; maxZ: number }): Bounds => ({ minX, maxX, minZ: z.minZ, maxZ: z.maxZ });

// Where each place is: the Management office, the Library, and the six department places in the order they fill.
const MANAGEMENT = rect(-HALF, -HALF + ROOM_W, NORTH);
const LIBRARY = rect(-HALF + ROOM_W, -INNER, NORTH);
const SLOT_RECTS: Bounds[] = [
  rect(INNER, INNER + ROOM_W, NORTH), // 0 north, right of the spine
  rect(-INNER - ROOM_W, -INNER, SOUTH), // 1 south, left of the spine
  rect(INNER, INNER + ROOM_W, SOUTH), // 2 south, right of the spine
  rect(INNER + ROOM_W, HALF, NORTH), // 3 north, outer right
  rect(-HALF, -INNER - ROOM_W, SOUTH), // 4 south, outer left
  rect(INNER + ROOM_W, HALF, SOUTH), // 5 south, outer right
];

const centre = (r: Bounds): Point => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 });
export const inside = (r: Bounds, p: Point) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;

/** Six desks in two rows of three, as the offices always had them. The first desk is the lead's. */
function roomDesks(r: Bounds): Point[] {
  const c = centre(r);
  return Array.from({ length: SEATS_PER_ROOM }, (_, s) => ({ x: c.x + ((s % 3) - 1) * 2.5, z: c.z + (s < 3 ? -1.1 : 2.3) }));
}

/** The open-plan desks: three rows of eight, with the walkway through the middle left free. */
function lobbyDesks(): Point[] {
  const xs = [-14, -10.5, -7, -3.5, 3.5, 7, 10.5, 14];
  return [2, 4.8, 7.6].flatMap((dz) => xs.map((x) => ({ x, z: LOBBY.minZ + dz })));
}

export const LOBBY_RECT = rect(-HALF, HALF, LOBBY);
export const CORRIDOR_RECT = rect(-HALF, HALF, CORRIDOR);
export const SPINE_RECT = rect(-INNER, INNER, { minZ: NORTH.minZ, maxZ: LOBBY.minZ });
/** The whole building, outer wall to outer wall. */
export const BUILDING_RECT: Bounds = { minX: -HALF, maxX: HALF, minZ: NORTH.minZ, maxZ: LOBBY.maxZ };
export const ENTRANCE: Point = { x: 0, z: LOBBY.maxZ };

export const MANAGEMENT_KEY = "management";
export const LIBRARY_KEY = "library";
export const VISITORS_KEY = "visitors";
export const deptKey = (name: string) => `dept:${name.trim().toLowerCase().replace(/\s+/g, " ")}`;

/** Seat numbers: the Management office first, then the six department places, then the Visitors area. */
export const MANAGEMENT_SEATS = SEATS_PER_ROOM;
export const VISITOR_SEATS = 24;
export const SEAT_COUNT = MANAGEMENT_SEATS + MAX_DEPARTMENTS * SEATS_PER_ROOM + VISITOR_SEATS;
const seatBase = (key: string, slot?: number) => (key === MANAGEMENT_KEY ? 0 : key === VISITORS_KEY ? MANAGEMENT_SEATS + MAX_DEPARTMENTS * SEATS_PER_ROOM : MANAGEMENT_SEATS + (slot as number) * SEATS_PER_ROOM);

export type Building = {
  rooms: RoomSpec[];
  /** The department places in use: room key to place. */
  slotOf: ReadonlyMap<string, number>;
};

/**
 * The rooms of the building for a team: the fixed ones, and one room per department up to MAX_DEPARTMENTS. A department keeps its place from
 * `previous` while it exists; a new one takes the first free place. Departments past the sixth have no room (their people sit in Visitors).
 * A department that means "management" shares the Management office.
 */
export function buildingFor(team: readonly Person[], previous: ReadonlyMap<string, number> = new Map()): Building {
  const names = new Map<string, string>(); // key to the name as first written
  for (const p of team) {
    const name = p.department?.trim();
    // The person at the top sits in the Management office whatever their department says, so it does not make a room.
    if (!name || p.reportsTo === null || kindOfDepartment(name) === "management") continue;
    if (!names.has(deptKey(name))) names.set(deptKey(name), name);
  }
  const slotOf = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of names.keys()) {
    const was = previous.get(key);
    if (was !== undefined && was >= 0 && was < MAX_DEPARTMENTS && !taken.has(was)) {
      slotOf.set(key, was);
      taken.add(was);
    }
  }
  for (const key of names.keys()) {
    if (slotOf.has(key)) continue;
    const free = Array.from({ length: MAX_DEPARTMENTS }, (_, n) => n).find((n) => !taken.has(n));
    if (free === undefined) break;
    slotOf.set(key, free);
    taken.add(free);
  }
  const door = (r: Bounds): Point => ({ x: centre(r).x, z: r.maxZ <= CORRIDOR.minZ + 1e-9 ? r.maxZ : r.minZ });
  const rooms: RoomSpec[] = [
    { key: MANAGEMENT_KEY, name: "Management", kind: "management", rect: MANAGEMENT, door: door(MANAGEMENT), desks: roomDesks(MANAGEMENT), color: 0 },
    { key: LIBRARY_KEY, name: "Library", kind: "library", rect: LIBRARY, door: door(LIBRARY), desks: [], color: 1 },
  ];
  for (const [key, slot] of [...slotOf].sort((a, b) => a[1] - b[1])) {
    const name = names.get(key) as string;
    const r = SLOT_RECTS[slot] as Bounds;
    rooms.push({ key, name, kind: kindOfDepartment(name), rect: r, door: door(r), desks: roomDesks(r), color: 2 + slot, slot });
  }
  rooms.push({ key: VISITORS_KEY, name: "Visitors", kind: "visitors", rect: LOBBY_RECT, door: ENTRANCE, desks: lobbyDesks(), color: 5 });
  return { rooms, slotOf };
}

/** Where a seat is on the floor, for the seat numbers above. */
export function seatPoint(building: Building, seat: number): Point | undefined {
  for (const room of building.rooms) {
    if (room.desks.length === 0) continue;
    const base = seatBase(room.key, room.slot);
    if (seat >= base && seat < base + room.desks.length) return room.desks[seat - base];
  }
  return undefined;
}

export type Placement = {
  /** Agent id to its room key. */
  roomOf: ReadonlyMap<string, string>;
  /** Agent id to its seat number. */
  seat: ReadonlyMap<string, number>;
  /** Agents that got no seat because every place they could take is full. */
  unseated: number;
};

export const emptyPlacement: Placement = { roomOf: new Map(), seat: new Map(), unseated: 0 };

/** The room an agent belongs in, before checking whether it has a free desk. */
function wantedRoom(agent: Agent, team: readonly Person[], building: Building): string {
  const role = roleOf(agent, team);
  if (!role) return VISITORS_KEY;
  const dept = role.person.department?.trim();
  if (role.person.reportsTo === null || (dept && kindOfDepartment(dept) === "management")) return MANAGEMENT_KEY;
  if (dept && building.slotOf.has(deptKey(dept))) return deptKey(dept);
  return VISITORS_KEY;
}

/**
 * Gives every agent a room and a desk, keeping the place of those already seated while it is still right, so nothing moves when
 * others come and go. A subagent joins its parent's room when a desk is free. A lead (a person someone reports to) is placed before the
 * others of a room, so it gets the first desk while that is free. A full room sends the agent to Visitors; a full Visitors area leaves it unseated.
 */
export function placeAgents(building: Building, previous: Placement, agents: readonly Agent[], team: readonly Person[]): Placement {
  const roomOf = new Map<string, string>();
  const seat = new Map<string, number>();
  const rooms = new Map(building.rooms.map((r) => [r.key, r]));
  const used = new Map<string, Set<number>>(building.rooms.map((r) => [r.key, new Set<number>()]));

  const take = (id: string, key: string, number: number) => {
    roomOf.set(id, key);
    seat.set(id, number);
    used.get(key)?.add(number);
  };
  const free = (key: string): number | undefined => {
    const room = rooms.get(key);
    if (!room || room.desks.length === 0) return undefined;
    const base = seatBase(key, room.slot);
    return Array.from({ length: room.desks.length }, (_, i) => base + i).find((n) => !used.get(key)?.has(n));
  };
  const valid = (key: string, number: number) => {
    const room = rooms.get(key);
    if (!room || room.desks.length === 0) return false;
    const base = seatBase(key, room.slot);
    return number >= base && number < base + room.desks.length;
  };

  const newcomers: Agent[] = [];
  for (const agent of agents) {
    const key = previous.roomOf.get(agent.id);
    const number = previous.seat.get(agent.id);
    // A desk is kept while it is still right: a subagent keeps the room it joined, an agent in Visitors stays there (it may have been sent
    // there because its room was full), and anyone else keeps it while it is the room they belong in.
    const stays = key !== undefined && number !== undefined && valid(key, number) && !used.get(key)?.has(number) && (agent.parentId !== null || key === VISITORS_KEY || key === wantedRoom(agent, team, building));
    if (stays) take(agent.id, key, number);
    else newcomers.push(agent);
  }

  const isLead = (a: Agent) => {
    const role = roleOf(a, team);
    return role !== null && team.some((p) => p.reportsTo === role.person.id);
  };
  const byId = new Map(agents.map((a) => [a.id, a]));
  const depth = (a: Agent): number => {
    let d = 0;
    for (let at: Agent | undefined = a; at?.parentId != null && d < 20; d++) at = byId.get(at.parentId);
    return d;
  };
  newcomers.sort((a, b) => depth(a) - depth(b) || Number(isLead(b)) - Number(isLead(a)) || a.project.localeCompare(b.project) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  let unseated = 0;
  for (const agent of newcomers) {
    const parentRoom = agent.parentId === null ? undefined : roomOf.get(agent.parentId);
    const tries = [...(parentRoom && free(parentRoom) !== undefined ? [parentRoom] : []), wantedRoom(agent, team, building), VISITORS_KEY];
    const key = tries.find((k) => free(k) !== undefined);
    const number = key === undefined ? undefined : free(key);
    if (key === undefined || number === undefined) {
      unseated++;
      continue;
    }
    take(agent.id, key, number);
  }
  return { roomOf, seat, unseated };
}

export const colourOf = (room: RoomSpec): string => ROOM_COLORS[room.color % ROOM_COLORS.length] as string;

/** What the camera frames: the whole building. */
export const overviewBounds = (): Bounds => ({ minX: BUILDING_RECT.minX - 1, maxX: BUILDING_RECT.maxX + 1, minZ: BUILDING_RECT.minZ - 1, maxZ: BUILDING_RECT.maxZ + 1 });

/** What the camera frames when one room has the focus. */
export const roomBounds = (room: RoomSpec): Bounds => ({ minX: room.rect.minX - 1, maxX: room.rect.maxX + 1, minZ: room.rect.minZ - 1, maxZ: room.rect.maxZ + 1 });
