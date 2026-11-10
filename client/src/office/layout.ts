// Camera framing and tag text. Where things stand is in building.ts.
import type { Bounds } from "./building.ts";

export const CAMERA_FOV_DEG = 35;
export const CAMERA_ELEVATION = (50 * Math.PI) / 180;
export const CAMERA_AZIMUTH = (25 * Math.PI) / 180;
const FILL = 0.94; // the area should fill about 78% of the view: the near edge looks bigger in perspective

/** Camera distance and the point it looks at, so the given area fills about 78% of the view. */
export function fitCamera(b: Bounds, aspect: number): { distance: number; target: [number, number, number] } {
  const width = b.maxX - b.minX;
  const depth = b.maxZ - b.minZ;
  const tanHalfV = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  // A canvas that has no size yet gives 0 or NaN; treat it as square instead of breaking the camera.
  const a = Number.isFinite(aspect) && aspect > 0.1 ? aspect : 1;
  const tanHalfH = tanHalfV * a;
  // What the box covers on screen, seen from the default angle.
  const needV = depth * Math.sin(CAMERA_ELEVATION) + 4 * Math.cos(CAMERA_ELEVATION);
  const needH = width * Math.cos(CAMERA_AZIMUTH) + depth * Math.sin(CAMERA_AZIMUTH);
  const distance = Math.max(needV / (2 * tanHalfV), needH / (2 * tanHalfH)) / FILL;
  // A tall, narrow window leaves empty space below the picture: aim a little higher so it sits in the middle.
  return { distance, target: [(b.minX + b.maxX) / 2, a < 0.8 ? 1.5 : -1, (b.minZ + b.maxZ) / 2] };
}

/** Text for a name tag: one line, at most `max` characters (not UTF-16 units), with an ellipsis when cut. */
export function truncateTag(name: string, max = 18): string {
  const flat = name.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join("") + "…";
}
