// Where things stand in the office. Everything here depends only on the desk number,
// so nothing moves when other agents come and go.

export const DESKS_PER_ROW = 6;
export const MAX_ROWS = 8;
/** Desks that are drawn. Agents beyond this stay in the list. */
export const VISIBLE_DESKS = DESKS_PER_ROW * MAX_ROWS;

const PITCH_X = 2.4;
const PITCH_Z = 3.0;
const CENTRAL_AISLE_HALF = 0.8; // widens the gap between columns 2 and 3 by 1.6
const CROSS_AISLE = 1.6; // extra space after every second row, kept clear for walking later

export function deskPosition(index: number): { x: number; z: number } {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`desk number must be a whole number from 0, got ${index}`);
  const column = index % DESKS_PER_ROW;
  const row = Math.floor(index / DESKS_PER_ROW);
  const x = (column - 2.5) * PITCH_X + (column >= 3 ? CENTRAL_AISLE_HALF : -CENTRAL_AISLE_HALF);
  const z = row * PITCH_Z + CROSS_AISLE * Math.floor(row / 2);
  return { x, z };
}

/** How many rows to draw so that the highest occupied desk is inside. Always between 1 and MAX_ROWS. */
export function rowsFor(highestDesk: number): number {
  if (highestDesk < 0) return 1;
  return Math.min(MAX_ROWS, Math.max(1, Math.floor(highestDesk / DESKS_PER_ROW) + 1));
}

export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** The floor slab for a number of rows, with a margin around the desks. */
export function floorBounds(rows: number): Bounds {
  const last = deskPosition((Math.max(1, Math.min(rows, MAX_ROWS)) - 1) * DESKS_PER_ROW).z;
  return { minX: -7.8, maxX: 7.8, minZ: -2.2, maxZ: last + 1.9 };
}

export const CAMERA_FOV_DEG = 35;
export const CAMERA_ELEVATION = (50 * Math.PI) / 180;
export const CAMERA_AZIMUTH = (25 * Math.PI) / 180;
const FILL = 0.78; // the occupied rows should fill about 78% of the view: the near edge looks bigger in perspective

/** Camera distance and the point it looks at, so the occupied rows fill about 80% of the view. */
export function fitCamera(rows: number, aspect: number): { distance: number; target: [number, number, number] } {
  const b = floorBounds(rows);
  const width = b.maxX - b.minX;
  const depth = b.maxZ - b.minZ;
  const tanHalfV = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  // A canvas that has no size yet gives 0 or NaN; treat it as square instead of breaking the camera.
  const tanHalfH = tanHalfV * (Number.isFinite(aspect) && aspect > 0.1 ? aspect : 1);
  // What the box covers on screen, seen from the default angle.
  const needV = depth * Math.sin(CAMERA_ELEVATION) + 4 * Math.cos(CAMERA_ELEVATION);
  const needH = width * Math.cos(CAMERA_AZIMUTH) + depth * Math.sin(CAMERA_AZIMUTH);
  const distance = Math.max(needV / (2 * tanHalfV), needH / (2 * tanHalfH)) / FILL;
  return { distance, target: [0, -1, (b.minZ + b.maxZ) / 2] };
}

/** Text for a name tag: one line, at most `max` characters (not UTF-16 units), with an ellipsis when cut. */
export function truncateTag(name: string, max = 18): string {
  const flat = name.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join("") + "…";
}
