// Rooms: one per project folder, up to MAX_ROOMS of them on a ring around the knowledge hub.
// Everything here is plain arithmetic, so it can be tested without drawing anything.
import type { Agent } from "../../../shared/events.ts";

export const SEATS_PER_ROOM = 6;
export const MAX_ROOMS = 8;
/** Seats that are drawn. Agents beyond this stay in the list. */
export const SEAT_COUNT = SEATS_PER_ROOM * MAX_ROOMS;

export const ROOM_W = 8;
export const ROOM_D = 7.2;
export const HUB_RADIUS = 3.5;
const RING_X = 14;
const RING_Z = 11;
const MARGIN = 1;
// The first rooms spread around the ring instead of piling up on one side.
const FILL_ORDER = [0, 4, 2, 6, 1, 5, 3, 7] as const;
const SEP = "\u0001";

/** The eight room colours: muted and distinct. */
export const ROOM_COLORS = ["#2E86AB", "#C8553D", "#4C9A6A", "#D9A21B", "#8E6BAE", "#2A9D8F", "#D17A9E", "#5C6BC0"] as const;

export type Assignment = {
  /** Room key to its place on the ring (0 to MAX_ROOMS - 1). Stable while the room has agents. */
  roomSlot: ReadonlyMap<string, number>;
  /** Agent id to its room key. */
  roomOf: ReadonlyMap<string, string>;
  /** Agent id to its seat number: room place times SEATS_PER_ROOM plus the seat in the room. */
  seat: ReadonlyMap<string, number>;
  /** Room key to its colour (an index into ROOM_COLORS). Rooms of one project share one; other projects get different ones while colours last. */
  colorOf: ReadonlyMap<string, number>;
  /** Agents that got no seat because every room is full. */
  unseated: number;
};

export const emptyAssignment: Assignment = { roomSlot: new Map(), roomOf: new Map(), seat: new Map(), colorOf: new Map(), unseated: 0 };

const keyFor = (project: string, n: number) => `${project}${SEP}${n}`;
const projectOf = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf(SEP)));

/** A sibling room's colour, else the first colour no other room uses, else one taken from the project's name. */
function pickColor(project: string, used: ReadonlyMap<string, number>): number {
  for (const [key, color] of used) if (projectOf(key) === project) return color;
  const inUse = new Set(used.values());
  const free = ROOM_COLORS.findIndex((_, i) => !inUse.has(i));
  if (free >= 0) return free;
  let h = 2166136261;
  for (let i = 0; i < project.length; i++) h = Math.imul(h ^ project.charCodeAt(i), 16777619);
  return (h >>> 0) % ROOM_COLORS.length;
}

/** The text on a room's sign: the project name, with a number from the second room of a project on. */
export function roomName(key: string): string {
  const at = key.lastIndexOf(SEP);
  if (at < 0) return key;
  const n = Number(key.slice(at + 1));
  const project = key.slice(0, at);
  return n > 1 ? `${project} ${n}` : project;
}

/**
 * Gives every agent a room and a seat, keeping the places of those that were already seated, so nothing
 * moves when others come and go. A new agent joins its parent's room if there is a free seat, else the
 * first room of its project with a free seat, else a new room.
 */
export function assignRooms(previous: Assignment, agents: readonly Agent[]): Assignment {
  const roomSlot = new Map<string, number>();
  const members = new Map<string, Set<string>>();
  const seat = new Map<string, number>();
  const roomOf = new Map<string, string>();
  const takenSlots = new Set<number>();
  const colorOf = new Map<string, number>();

  const place = (agentId: string, key: string, seatNumber: number) => {
    members.get(key)?.add(agentId);
    seat.set(agentId, seatNumber);
    roomOf.set(agentId, key);
  };

  const newcomers: Agent[] = [];
  for (const agent of agents) {
    const key = previous.roomOf.get(agent.id);
    const seatNumber = previous.seat.get(agent.id);
    const slot = key === undefined ? undefined : previous.roomSlot.get(key);
    if (key === undefined || seatNumber === undefined || slot === undefined || Math.floor(seatNumber / SEATS_PER_ROOM) !== slot) {
      newcomers.push(agent);
      continue;
    }
    if (!roomSlot.has(key)) {
      roomSlot.set(key, slot);
      members.set(key, new Set());
      takenSlots.add(slot);
      colorOf.set(key, previous.colorOf.get(key) ?? 0);
    }
    place(agent.id, key, seatNumber);
  }

  const freeSlot = () => Array.from({ length: MAX_ROOMS }, (_, n) => n).find((n) => !takenSlots.has(n));
  const freeSeat = (key: string) => {
    const slot = roomSlot.get(key) as number;
    const used = new Set([...(members.get(key) ?? [])].map((id) => (seat.get(id) as number) % SEATS_PER_ROOM));
    for (let s = 0; s < SEATS_PER_ROOM; s++) if (!used.has(s)) return slot * SEATS_PER_ROOM + s;
    return undefined;
  };

  newcomers.sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null) || a.project.localeCompare(b.project) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  let unseated = 0;
  for (const agent of newcomers) {
    let key = agent.parentId === null ? undefined : roomOf.get(agent.parentId);
    if (key !== undefined && (members.get(key)?.size ?? SEATS_PER_ROOM) >= SEATS_PER_ROOM) key = undefined;
    for (let n = 1; key === undefined; n++) {
      const candidate = keyFor(agent.project, n);
      const existing = members.get(candidate);
      if (existing) {
        if (existing.size < SEATS_PER_ROOM) key = candidate;
        continue;
      }
      const slot = freeSlot();
      if (slot === undefined) break;
      roomSlot.set(candidate, slot);
      members.set(candidate, new Set());
      takenSlots.add(slot);
      colorOf.set(candidate, pickColor(agent.project, colorOf));
      key = candidate;
    }
    const seatNumber = key === undefined ? undefined : freeSeat(key);
    if (key === undefined || seatNumber === undefined) {
      unseated++;
      continue;
    }
    place(agent.id, key, seatNumber);
  }
  return { roomSlot, roomOf, seat, colorOf, unseated };
}

export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

export function roomCenter(slot: number): { x: number; z: number } {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ROOMS) throw new RangeError(`room place must be a whole number from 0 to ${MAX_ROOMS - 1}, got ${slot}`);
  const angle = -Math.PI / 2 + (FILL_ORDER[slot] as number) * (Math.PI / 4);
  return { x: RING_X * Math.cos(angle), z: RING_Z * Math.sin(angle) };
}

export function roomRect(slot: number): Bounds {
  const c = roomCenter(slot);
  return { minX: c.x - ROOM_W / 2, maxX: c.x + ROOM_W / 2, minZ: c.z - ROOM_D / 2, maxZ: c.z + ROOM_D / 2 };
}

/** Where a seat is on the floor. Desks face +z (toward the camera); the person sits on the -z side. */
export function seatPosition(seat: number): { x: number; z: number } {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) throw new RangeError(`seat number must be a whole number from 0 to ${SEAT_COUNT - 1}, got ${seat}`);
  const c = roomCenter(Math.floor(seat / SEATS_PER_ROOM));
  const s = seat % SEATS_PER_ROOM;
  return { x: c.x + ((s % 3) - 1) * 2.5, z: c.z + (s < 3 ? -1.1 : 2.3) };
}

const union = (rects: Bounds[]): Bounds => ({
  minX: Math.min(...rects.map((r) => r.minX)),
  maxX: Math.max(...rects.map((r) => r.maxX)),
  minZ: Math.min(...rects.map((r) => r.minZ)),
  maxZ: Math.max(...rects.map((r) => r.maxZ)),
});

const hubRect: Bounds = { minX: -HUB_RADIUS, maxX: HUB_RADIUS, minZ: -HUB_RADIUS, maxZ: HUB_RADIUS };
const pad = (b: Bounds): Bounds => ({ minX: b.minX - MARGIN, maxX: b.maxX + MARGIN, minZ: b.minZ - MARGIN, maxZ: b.maxZ + MARGIN });

/** What the camera frames: the hub and every room in use. */
export const overviewBounds = (slots: readonly number[]): Bounds => pad(union([hubRect, ...slots.map(roomRect)]));

/** What the camera frames when one room has the focus. */
export const roomBounds = (slot: number): Bounds => pad(roomRect(slot));

/** The strip of road from the hub to a room's edge. */
export function roadSegment(slot: number): { x: number; z: number; length: number; angle: number } {
  const c = roomCenter(slot);
  const distance = Math.hypot(c.x, c.z);
  const dx = c.x / distance;
  const dz = c.z / distance;
  const entry = Math.max(Math.abs(dx) > 1e-6 ? (Math.abs(c.x) - ROOM_W / 2) / Math.abs(dx) : 0, Math.abs(dz) > 1e-6 ? (Math.abs(c.z) - ROOM_D / 2) / Math.abs(dz) : 0);
  const length = Math.max(0, entry - HUB_RADIUS);
  const mid = HUB_RADIUS + length / 2;
  return { x: dx * mid, z: dz * mid, length, angle: Math.atan2(dx, dz) };
}
