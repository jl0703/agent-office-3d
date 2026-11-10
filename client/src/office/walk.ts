// Where a character walks. Inside a room it keeps to the aisle and the gaps between desks and leaves by the room's door onto the
// corridor; between rooms it follows the corridor (and the spine to the Visitors area). Pure geometry, no drawing.
import { LOBBY_RECT, VISITORS_KEY, seatPoint, type Building, type Point, type RoomSpec } from "./building.ts";

export type { Point };

export const WALK_SPEED = 2.2; // metres per second
export const CORRIDOR_Z = -2.7; // the middle of the corridor
const AISLE_Z = 0.3; // local z of the aisle between the two rows of desks in a room
const GAPS = [-3.75, -1.25, 1.25, 3.75] as const; // local x of the free columns between desks in a room
const DOOR_DEPTH = 0.6; // how far inside the door the path turns
const LOBBY_GAPS = [-16, -12.25, -8.75, -5.25, 0, 5.25, 8.75, 12.25, 16] as const;
const LOBBY_STRIP_Z = LOBBY_RECT.minZ + 0.55; // the free strip along the top of the Visitors area, above the first row

const centreOf = (r: RoomSpec): Point => ({ x: (r.rect.minX + r.rect.maxX) / 2, z: (r.rect.minZ + r.rect.maxZ) / 2 });

/** The room a seat number is in, and which of its desks it is. */
function roomOfSeat(building: Building, seat: number): { room: RoomSpec; desk: number } | undefined {
  const at = seatPoint(building, seat);
  if (!at) return undefined;
  const room = building.rooms.find((r) => r.desks.some((d) => d.x === at.x && d.z === at.z));
  return room ? { room, desk: room.desks.findIndex((d) => d.x === at.x && d.z === at.z) } : undefined;
}

/** Where the person sits: the same spot the scene draws them, behind the desk. */
export function seatSpot(building: Building, seat: number): Point {
  const p = seatPoint(building, seat) as Point;
  return { x: p.x, z: p.z - 0.75 };
}

const nearestGap = (gaps: readonly number[], x: number, toward: number) => {
  // Of the free columns next to a desk's column, the one nearer `toward`.
  const next = gaps.filter((g) => Math.abs(g - x) < 3.6 && Math.abs(g - x) > 0.3);
  return [...(next.length > 0 ? next : gaps)].sort((a, b) => Math.abs(a - toward) - Math.abs(b - toward))[0] as number;
};

/** Where a visitor stands next to a seat: in the free column beside it, on the side nearer the door. */
export function visitSpot(building: Building, seat: number): Point {
  const found = roomOfSeat(building, seat);
  if (!found) return seatSpot(building, seat);
  const { room } = found;
  const desk = room.desks[found.desk] as Point;
  if (room.key === VISITORS_KEY) return { x: nearestGap(LOBBY_GAPS, desk.x, 0), z: desk.z - 0.75 };
  const c = centreOf(room);
  return { x: c.x + nearestGap(GAPS, desk.x - c.x, 0), z: desk.z - 0.75 };
}

export type Stand = { seat: number; at: "seat" | "visit" };

const spotOf = (b: Building, s: Stand) => (s.at === "seat" ? seatSpot(b, s.seat) : visitSpot(b, s.seat));
const reversed = <T>(list: T[]) => [...list].reverse();

/** From a point in a department or management room to its door, in world coordinates. */
function toDoor(room: RoomSpec, from: Point, isSeat: boolean): Point[] {
  const c = centreOf(room);
  const northDoor = room.door.z === room.rect.minZ;
  const innerZ = room.door.z + (northDoor ? DOOR_DEPTH : -DOOR_DEPTH);
  const local = { x: from.x - c.x, z: from.z - c.z };
  const out: Point[] = [from];
  let column = local.x;
  if (isSeat) {
    column = nearestGap(GAPS, local.x, room.door.x - c.x);
    out.push({ x: c.x + column, z: from.z });
  }
  out.push({ x: c.x + column, z: c.z + AISLE_Z });
  const gap = [...GAPS].sort((a, b) => Math.abs(a - (room.door.x - c.x)) - Math.abs(b - (room.door.x - c.x)))[0] as number;
  out.push({ x: c.x + gap, z: c.z + AISLE_Z }, { x: c.x + gap, z: innerZ }, { x: room.door.x, z: innerZ }, { x: room.door.x, z: room.door.z });
  return out;
}

/** From a point in the Visitors area to the top of the spine, in world coordinates. */
function lobbyToSpine(from: Point, isSeat: boolean): Point[] {
  const out: Point[] = [from];
  let column = from.x;
  if (isSeat) {
    column = nearestGap(LOBBY_GAPS, from.x, 0);
    out.push({ x: column, z: from.z });
  }
  out.push({ x: column, z: LOBBY_STRIP_Z }, { x: 0, z: LOBBY_STRIP_Z });
  return out;
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - (points[i - 1] as Point).x, p.z - (points[i - 1] as Point).z) > 1e-6);
}

/** The waypoints from one standing place to another, in world coordinates. Same room: along the aisle. Otherwise out of the door, along the corridor (and the spine), in at the other door. */
export function walkRoute(building: Building, from: Stand, to: Stand): Point[] {
  const a = roomOfSeat(building, from.seat);
  const b = roomOfSeat(building, to.seat);
  if (!a || !b) return [];
  const spotA = spotOf(building, from);
  const spotB = spotOf(building, to);
  const fromSeat = from.at === "seat";
  const toSeat = to.at === "seat";
  if (a.room.key === b.room.key) {
    if (a.room.key === VISITORS_KEY) {
      const gapA = fromSeat ? nearestGap(LOBBY_GAPS, spotA.x, spotB.x) : spotA.x;
      const gapB = toSeat ? nearestGap(LOBBY_GAPS, spotB.x, spotA.x) : spotB.x;
      const pts = [spotA, ...(fromSeat ? [{ x: gapA, z: spotA.z }] : []), { x: gapA, z: LOBBY_STRIP_Z }, { x: gapB, z: LOBBY_STRIP_Z }, ...(toSeat ? [{ x: gapB, z: spotB.z }] : []), spotB];
      return dedupe(pts);
    }
    const c = centreOf(a.room);
    const gapA = fromSeat ? nearestGap(GAPS, spotA.x - c.x, spotB.x - c.x) : spotA.x - c.x;
    const gapB = toSeat ? nearestGap(GAPS, spotB.x - c.x, spotA.x - c.x) : spotB.x - c.x;
    const pts: Point[] = [spotA];
    if (fromSeat) pts.push({ x: c.x + gapA, z: spotA.z });
    pts.push({ x: c.x + gapA, z: c.z + AISLE_Z }, { x: c.x + gapB, z: c.z + AISLE_Z });
    if (toSeat) pts.push({ x: c.x + gapB, z: spotB.z });
    pts.push(spotB);
    return dedupe(pts);
  }
  const leaveLobby = a.room.key === VISITORS_KEY;
  const enterLobby = b.room.key === VISITORS_KEY;
  const leave = leaveLobby ? [...lobbyToSpine(spotA, fromSeat), { x: 0, z: LOBBY_RECT.minZ - 0.3 }, { x: 0, z: CORRIDOR_Z }] : [...toDoor(a.room, spotA, fromSeat), { x: a.room.door.x, z: CORRIDOR_Z }];
  const arrive = enterLobby ? reversed([...lobbyToSpine(spotB, toSeat), { x: 0, z: LOBBY_RECT.minZ - 0.3 }, { x: 0, z: CORRIDOR_Z }]) : reversed([...toDoor(b.room, spotB, toSeat), { x: b.room.door.x, z: CORRIDOR_Z }]);
  return dedupe([...leave, ...arrive]);
}

export function routeLength(route: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += Math.hypot((route[i] as Point).x - (route[i - 1] as Point).x, (route[i] as Point).z - (route[i - 1] as Point).z);
  return total;
}

/** Seconds to walk a route at the walking speed. */
export const routeSeconds = (route: readonly Point[]) => routeLength(route) / WALK_SPEED;

/** The position and facing (radians about the vertical axis; 0 faces +z) after walking `distance` along a route. */
export function pointAlong(route: readonly Point[], distance: number): Point & { heading: number } {
  const first = route[0] as Point;
  let left = Math.max(0, distance);
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1] as Point;
    const b = route[i] as Point;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= seg || i === route.length - 1) {
      const t = seg === 0 ? 1 : Math.min(1, left / seg);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    left -= seg;
  }
  return { x: first.x, z: first.z, heading: 0 };
}

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** The solid things on the floor, for tests: every desk, and the chair behind it (except the one of `exceptSeat`, the person who is walking). */
export function obstacles(building: Building, seats: Iterable<number>, exceptSeat?: number): Rect[] {
  const rects: Rect[] = [];
  for (const seat of seats) {
    const d = seatPoint(building, seat);
    if (!d) continue;
    rects.push({ minX: d.x - 0.8, maxX: d.x + 0.8, minZ: d.z - 0.45, maxZ: d.z + 0.45 });
    if (seat !== exceptSeat) rects.push({ minX: d.x - 0.3, maxX: d.x + 0.3, minZ: d.z - 1.05, maxZ: d.z - 0.6 });
  }
  return rects;
}
