// Where a character walks. Inside a room it keeps to the aisle and the gaps between desks; outside it
// follows the road to the hub, goes round the hub's edge, and follows the other room's road. Pure geometry.
import { HUB_RADIUS, ROOM_D, ROOM_W, SEATS_PER_ROOM, roomCenter, seatPosition } from "./rooms.ts";

export type Point = { x: number; z: number };

export const WALK_SPEED = 2.2; // metres per second
const AISLE_Z = 0.3; // local z of the corridor between the two rows of desks
const GAPS = [-3.75, -1.25, 1.25, 3.75] as const; // local x of the free columns between desks
const RING = HUB_RADIUS + 1.4; // how far from the hub's centre people walk round it
const ARC_STEP = (20 * Math.PI) / 180;

// Local desk layout (see seatPosition): three columns, two rows.
const COLUMNS = [-2.5, 0, 2.5] as const;
const ROW_Z = [-1.1, 2.3] as const;

/** Where the person sits: the same spot the scene draws them, behind the desk. */
export function seatSpot(seat: number): Point {
  const p = seatPosition(seat);
  return { x: p.x, z: p.z - 0.75 };
}

/** Where a visitor stands next to a seat: in the free column beside it, on the side nearer the exit. */
export function visitSpot(seat: number): Point {
  const local = localOf(seat);
  const gap = nearestGap(local.x, 0);
  return { x: roomCenter(roomOf(seat)).x + gap, z: roomCenter(roomOf(seat)).z + local.z };
}

const roomOf = (seat: number) => Math.floor(seat / SEATS_PER_ROOM);

function localOf(seat: number): Point {
  const s = seat % SEATS_PER_ROOM;
  return { x: COLUMNS[s % 3] as number, z: (ROW_Z[s < 3 ? 0 : 1] as number) - 0.75 };
}

const nearestGap = (x: number, toward: number) => {
  // Of the two gaps next to a column, the one nearer `toward`.
  const next = GAPS.filter((g) => Math.abs(g - x) < 1.3);
  return (next.sort((a, b) => Math.abs(a - toward) - Math.abs(b - toward))[0] ?? GAPS[0]) as number;
};

const nearestAnyGap = (x: number) => [...GAPS].sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0] as number;

/** Where the line from a room's centre to the hub leaves the room, in the room's own coordinates. */
function exitPoint(slot: number): Point {
  const c = roomCenter(slot);
  const len = Math.hypot(c.x, c.z);
  const dx = -c.x / len;
  const dz = -c.z / len;
  const t = Math.min(Math.abs(dx) > 1e-9 ? ROOM_W / 2 / Math.abs(dx) : Infinity, Math.abs(dz) > 1e-9 ? ROOM_D / 2 / Math.abs(dz) : Infinity);
  return { x: dx * t, z: dz * t };
}

function exitInfo(slot: number): { edge: Point; inner: Point; onX: boolean } {
  const edge = exitPoint(slot);
  const onX = Math.abs(Math.abs(edge.x) - ROOM_W / 2) < 1e-6;
  const inward = onX ? { x: -Math.sign(edge.x) * 0.6, z: 0 } : { x: 0, z: -Math.sign(edge.z) * 0.6 };
  return { edge, inner: { x: edge.x + inward.x, z: edge.z + inward.z }, onX };
}

/** From a point in a room (a seat or a spot beside one) to just inside the room's exit, in local coordinates. */
function toExit(from: Point, isSeat: boolean, slot: number): Point[] {
  const { edge, inner, onX } = exitInfo(slot);
  const out: Point[] = [from];
  let column = from.x;
  if (isSeat) {
    column = nearestGap(from.x, edge.x);
    out.push({ x: column, z: from.z });
  }
  out.push({ x: column, z: AISLE_Z });
  if (onX) {
    out.push({ x: inner.x, z: AISLE_Z }, { x: inner.x, z: inner.z });
  } else {
    const gap = nearestAnyGap(edge.x);
    out.push({ x: gap, z: AISLE_Z }, { x: gap, z: inner.z }, { x: inner.x, z: inner.z });
  }
  out.push(edge);
  return out;
}

const reversed = <T>(list: T[]) => [...list].reverse();
const toWorld = (slot: number, p: Point): Point => ({ x: roomCenter(slot).x + p.x, z: roomCenter(slot).z + p.z });

/** The road part: from a room's exit to the ring round the hub, along the road. */
function roadToRing(slot: number): Point[] {
  const c = roomCenter(slot);
  const len = Math.hypot(c.x, c.z);
  const dir = { x: c.x / len, z: c.z / len };
  const edge = toWorld(slot, exitPoint(slot));
  return [edge, { x: dir.x * RING, z: dir.z * RING }];
}

function arc(from: Point, to: Point): Point[] {
  const a = Math.atan2(from.z, from.x);
  let d = Math.atan2(to.z, to.x) - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil(Math.abs(d) / ARC_STEP));
  return Array.from({ length: steps - 1 }, (_, i) => {
    const angle = a + (d * (i + 1)) / steps;
    return { x: Math.cos(angle) * RING, z: Math.sin(angle) * RING };
  });
}

export type Stand = { seat: number; at: "seat" | "visit" };

const spotOf = (s: Stand) => (s.at === "seat" ? seatSpot(s.seat) : visitSpot(s.seat));

/** The waypoints from one standing place to another, in world coordinates. Same room: along the aisle. */
export function walkRoute(from: Stand, to: Stand): Point[] {
  const slotA = roomOf(from.seat);
  const slotB = roomOf(to.seat);
  const centerA = roomCenter(slotA);
  const centerB = roomCenter(slotB);
  const a = spotOf(from);
  const b = spotOf(to);
  const localA = { x: a.x - centerA.x, z: a.z - centerA.z };
  const localB = { x: b.x - centerB.x, z: b.z - centerB.z };
  if (slotA === slotB) {
    const gapA = from.at === "seat" ? nearestGap(localA.x, localB.x) : localA.x;
    const gapB = to.at === "seat" ? nearestGap(localB.x, localA.x) : localB.x;
    const pts: Point[] = [localA];
    if (from.at === "seat") pts.push({ x: gapA, z: localA.z });
    pts.push({ x: gapA, z: AISLE_Z }, { x: gapB, z: AISLE_Z });
    if (to.at === "seat") pts.push({ x: gapB, z: localB.z });
    pts.push(localB);
    return dedupe(pts.map((p) => toWorld(slotA, p)));
  }
  const leave = toExit(localA, from.at === "seat", slotA).map((p) => toWorld(slotA, p));
  const arrive = reversed(toExit(localB, to.at === "seat", slotB)).map((p) => toWorld(slotB, p));
  const roadA = roadToRing(slotA);
  const roadB = reversed(roadToRing(slotB));
  const round = arc(roadA[1] as Point, roadB[0] as Point);
  return dedupe([...leave, ...roadA.slice(1), ...round, ...roadB, ...arrive.slice(1)].map((p) => ({ ...p })));
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - (points[i - 1] as Point).x, p.z - (points[i - 1] as Point).z) > 1e-6);
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

/** The solid things in one room, in the room's own coordinates, for tests: desks and the chairs of everyone else. */
export function obstacles(exceptSeat?: number): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
  const rects: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  for (let s = 0; s < SEATS_PER_ROOM; s++) {
    const cx = COLUMNS[s % 3] as number;
    const rz = ROW_Z[s < 3 ? 0 : 1] as number;
    rects.push({ minX: cx - 0.8, maxX: cx + 0.8, minZ: rz - 0.45, maxZ: rz + 0.45 });
    if (s !== exceptSeat) rects.push({ minX: cx - 0.3, maxX: cx + 0.3, minZ: rz - 1.05, maxZ: rz - 0.6 });
  }
  return rects;
}
