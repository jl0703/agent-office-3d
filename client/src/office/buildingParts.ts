// What stands in the building besides desks: the walls (with gaps for the doors) and each room's furniture. Plain arithmetic.
import { BUILDING_RECT, ENTRANCE, type Building, type Point, type RoomSpec } from "./building.ts";

export const WALL_THICK = 0.25;
export const WALL_TALL = 2.6;
export const WALL_GLASS = 0.8;
export const DOOR_GAP = 1.8;

/** A wall piece on the floor: its centre, its size on the floor and how high it is. `tall` walls are the back and left walls the camera looks at; `glass` ones are low and see-through so the rooms can be seen into. */
export type Wall = { x: number; z: number; w: number; d: number; kind: "tall" | "glass" };

type Seg = { x0: number; z0: number; x1: number; z1: number; kind: "tall" | "glass"; gap?: number };

/** Splits a straight segment around a gap (a door) of DOOR_GAP centred at `at`. */
function cut(seg: Seg): Seg[] {
  if (seg.gap === undefined) return [seg];
  const horizontal = seg.z0 === seg.z1;
  const [a, b] = horizontal ? [seg.x0, seg.x1] : [seg.z0, seg.z1];
  const lo = seg.gap - DOOR_GAP / 2;
  const hi = seg.gap + DOOR_GAP / 2;
  const parts: [number, number][] = [];
  if (lo > a + 1e-9) parts.push([a, Math.min(lo, b)]);
  if (hi < b - 1e-9) parts.push([Math.max(hi, a), b]);
  return parts.map(([p, q]) => (horizontal ? { ...seg, x0: p, x1: q } : { ...seg, z0: p, z1: q }));
}

const toWall = (s: Seg): Wall => {
  const horizontal = s.z0 === s.z1;
  return horizontal
    ? { x: (s.x0 + s.x1) / 2, z: s.z0, w: s.x1 - s.x0 + WALL_THICK, d: WALL_THICK, kind: s.kind }
    : { x: s.x0, z: (s.z0 + s.z1) / 2, w: WALL_THICK, d: s.z1 - s.z0 + WALL_THICK, kind: s.kind };
};

/**
 * The walls of the building. The back (north) wall and every room's left wall are full height, as the camera looks from the south
 * and the right; the walls facing the camera are low glass, so every room can be seen into. Each room's door is a gap in its wall
 * on the corridor; the entrance is a gap in the near wall. Rooms that share an edge share one wall.
 */
export function wallsOf(building: Building): Wall[] {
  const B = BUILDING_RECT;
  const segs = new Map<string, Seg>();
  const add = (seg: Seg) => {
    const key = `${seg.x0},${seg.z0},${seg.x1},${seg.z1}`;
    const old = segs.get(key);
    if (!old || (seg.kind === "tall" && old.kind === "glass")) segs.set(key, seg);
  };
  add({ x0: B.minX, z0: B.minZ, x1: B.maxX, z1: B.minZ, kind: "tall" });
  add({ x0: B.minX, z0: B.minZ, x1: B.minX, z1: B.maxZ, kind: "tall" });
  add({ x0: B.maxX, z0: B.minZ, x1: B.maxX, z1: B.maxZ, kind: "glass" });
  add({ x0: B.minX, z0: B.maxZ, x1: B.maxX, z1: B.maxZ, kind: "glass", gap: ENTRANCE.x });
  for (const room of building.rooms) {
    if (room.kind === "visitors") continue;
    const r = room.rect;
    add({ x0: r.minX, z0: r.minZ, x1: r.minX, z1: r.maxZ, kind: "tall" });
    add({ x0: r.maxX, z0: r.minZ, x1: r.maxX, z1: r.maxZ, kind: "glass" });
    const doorOnNorthEdge = room.door.z === r.minZ;
    add({ x0: r.minX, z0: r.minZ, x1: r.maxX, z1: r.minZ, kind: doorOnNorthEdge ? "glass" : "tall", ...(doorOnNorthEdge ? { gap: room.door.x } : {}) });
    add({ x0: r.minX, z0: r.maxZ, x1: r.maxX, z1: r.maxZ, kind: "glass", ...(!doorOnNorthEdge ? { gap: room.door.x } : {}) });
  }
  // A shared vertical edge appears twice (one room's right, the next one's left): the tall one was kept above.
  return [...segs.values()].flatMap(cut).map(toWall);
}

/** One box of furniture: its centre on the floor, its size, its colour and how high off the floor its underside is (a device on a bench). */
export type Furniture = { x: number; z: number; w: number; d: number; h: number; color: string; y?: number };

const WOOD = "#9a7448";
const DARK = "#2f3640";
const FABRIC = "#5b6b7a";
const PAPER = "#e9e4d6";
const SCREEN = "#1d2530";
const LIGHT = "#7fd1c7";

/**
 * Furniture for one room, as boxes, kept to the strip along the back wall: the desks and their chairs fill the middle, and the door is
 * on the other edge or kept clear in the middle of this one. Every piece is pushed inside the room's walls.
 */
export function furnitureOf(room: RoomSpec): Furniture[] {
  const r = room.rect;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const left = r.minX + 0.9;
  const right = r.maxX - 0.9;
  const backZ = r.minZ + 0.2;
  const piece = (x: number, z: number, w: number, d: number, h: number, color: string, y = 0): Furniture => ({
    x: Math.min(Math.max(x, r.minX + 0.15 + w / 2), r.maxX - 0.15 - w / 2),
    z: Math.min(Math.max(z, r.minZ + 0.15 + d / 2), r.maxZ - 0.15 - d / 2),
    w,
    d,
    h,
    color,
    ...(y > 0 ? { y } : {}),
  });
  switch (room.kind) {
    case "management":
      return [piece(right, backZ, 2.4, 0.9, 0.75, WOOD), piece(left, backZ, 0.8, 1.2, 1.1, DARK)];
    case "library":
      return [piece(left, cz, 0.6, 5.4, 1.9, WOOD), piece(cx, backZ, 5.4, 0.6, 1.9, WOOD), piece(right, cz + 0.8, 0.6, 3, 1.9, WOOD)];
    case "engineering":
      return [piece(right, backZ, 0.8, 0.8, 1.7, DARK), piece(right - 1.1, backZ, 0.8, 0.8, 1.7, DARK), piece(left, backZ, 1.8, 0.8, 0.5, FABRIC)];
    case "qa":
      return [piece(cx + 2.6, backZ, 2.4, 0.8, 0.9, WOOD), piece(cx + 1.9, backZ, 0.35, 0.25, 0.08, SCREEN, 0.9), piece(cx + 2.6, backZ, 0.35, 0.25, 0.08, LIGHT, 0.9), piece(cx + 3.3, backZ, 0.35, 0.25, 0.08, SCREEN, 0.9), piece(left, backZ, 0.5, 1.2, 1.6, PAPER)];
    case "design":
      return [piece(cx + 2.6, backZ, 2.2, 0.2, 1.5, SCREEN), piece(left, backZ, 1.4, 0.8, 0.7, PAPER)];
    case "product":
      return [piece(right - 0.4, backZ, 1.2, 1.2, 0.7, WOOD), piece(left, backZ, 0.15, 1.2, 1.6, PAPER)];
    case "operations":
      return [piece(cx + 3.2, backZ, 1.1, 0.2, 1.4, SCREEN), piece(cx + 1.95, backZ, 1.1, 0.2, 1.4, SCREEN), piece(left, backZ, 1.6, 0.8, 0.5, FABRIC)];
    case "general":
      return [piece(right - 0.4, backZ, 2.0, 0.9, 0.5, FABRIC), piece(left, backZ, 1.0, 1.0, 0.45, WOOD)];
    case "visitors":
      return [piece(-8, r.maxZ, 3.2, 0.9, 1.0, WOOD), piece(8, r.maxZ, 2.6, 0.9, 0.5, FABRIC), piece(-14.5, r.maxZ, 1.4, 1.4, 0.5, FABRIC)];
  }
}

/** The Library room's centre: where the knowledge hub stands. */
export const hubCentre = (building: Building): Point => {
  const lib = building.rooms.find((r) => r.kind === "library");
  return lib ? { x: (lib.rect.minX + lib.rect.maxX) / 2, z: (lib.rect.minZ + lib.rect.maxZ) / 2 } : { x: 0, z: 0 };
};

/** How big the hub is drawn in the Library: it was drawn with this radius in the middle of the old ring. */
export const HUB_SCALE = 0.78;
