import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  PlaneGeometry,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AgentStatus } from "../../../shared/events.ts";
import type { Accessory, Scheme } from "./palette.ts";
import { SCENE } from "./palette.ts";

// Everything is built from a few simple shapes and merged, so each kind of thing is drawn in one call.
// Units are roughly metres. A desk faces +z; the character sits on its -z side, facing +z.

type Part = { geometry: BufferGeometry; color: string };

/** Moves and turns a shape into place. */
function place(g: BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): BufferGeometry {
  const m = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz));
  m.setPosition(x, y, z);
  return g.applyMatrix4(m);
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, ry = 0, rz = 0): Part => ({
  geometry: place(new BoxGeometry(w, h, d), x, y, z, 0, ry, rz),
  color,
});

/** Joins parts into one shape, each part keeping its own colour. */
function merge(parts: Part[]): BufferGeometry {
  const color = new Color();
  const prepared = parts.map(({ geometry, color: hex }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.deleteAttribute("uv");
    color.set(hex);
    const count = g.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
    g.setAttribute("color", new Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error("could not merge shapes");
  prepared.forEach((g) => g.dispose());
  return merged;
}

export function deskGeometry(scheme: Scheme): BufferGeometry {
  const c = SCENE[scheme];
  const parts: Part[] = [box(1.5, 0.08, 0.8, 0, 0.76, 0, c.desk)];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.07, 0.72, 0.07, sx * 0.68, 0.36, sz * 0.33, c.deskDark));
  parts.push(box(0.5, 0.03, 0.2, 0, 0.815, -0.2, "#3B4350")); // keyboard
  parts.push(box(0.28, 0.02, 0.2, -0.5, 0.81, 0.1, "#FBF8F0")); // paper
  return merge(parts);
}

export function chairGeometry(scheme: Scheme): BufferGeometry {
  const seat = scheme === "light" ? "#35527A" : "#4B6A94";
  const metal = scheme === "light" ? "#5A6472" : "#8A94A3";
  return merge([
    box(0.5, 0.07, 0.5, 0, 0.45, 0, seat),
    box(0.5, 0.5, 0.06, 0, 0.75, -0.25, seat),
    box(0.06, 0.4, 0.06, 0, 0.22, 0, metal),
    box(0.5, 0.04, 0.06, 0, 0.03, 0, metal),
    box(0.06, 0.04, 0.5, 0, 0.03, 0, metal),
  ]);
}

export function monitorGeometry(): BufferGeometry {
  return merge([
    box(0.3, 0.03, 0.2, 0, 0.015, 0, "#2B3340"),
    box(0.05, 0.25, 0.05, 0, 0.15, 0, "#2B3340"),
    box(0.62, 0.4, 0.04, 0, 0.5, 0, "#2B3340"),
  ]);
}

/** A flat panel the screen texture is drawn on, sitting just in front of the monitor frame. */
export const screenGeometry = () => place(new PlaneGeometry(0.54, 0.32), 0, 0.5, 0.025);

export function legsGeometry(): BufferGeometry {
  const parts: Part[] = [];
  for (const side of [-1, 1]) {
    parts.push(box(0.16, 0.14, 0.45, side * 0.11, 0.52, 0.23, "#4A5568"));
    parts.push(box(0.14, 0.45, 0.14, side * 0.11, 0.24, 0.43, "#4A5568"));
  }
  return merge(parts);
}

/** Torso and arms are plain white here; each character's colour comes from the instance colour. */
export const torsoGeometry = () => place(new CapsuleGeometry(0.2, 0.3, 2, 6), 0, 0.25, 0);
export const armGeometry = () => place(new CapsuleGeometry(0.06, 0.26, 2, 6), 0, -0.19, 0);

export function headGeometry(scheme: Scheme): BufferGeometry {
  return merge([
    { geometry: new RoundedBoxGeometry(0.36, 0.34, 0.34, 2, 0.08), color: SCENE[scheme].skin },
    box(0.05, 0.06, 0.02, -0.08, 0.02, 0.175, "#222B38"),
    box(0.05, 0.06, 0.02, 0.08, 0.02, 0.175, "#222B38"),
  ]);
}

/** Small extras that make characters easy to tell apart. Built around the head (the tie, around the torso). */
export function accessoryGeometry(kind: Exclude<Accessory, "none">): BufferGeometry {
  switch (kind) {
    case "glasses":
      return merge([
        box(0.12, 0.09, 0.02, -0.09, 0.02, 0.185, "#222B38"),
        box(0.12, 0.09, 0.02, 0.09, 0.02, 0.185, "#222B38"),
        box(0.04, 0.015, 0.02, 0, 0.03, 0.185, "#222B38"),
      ]);
    case "headphones":
      return merge([
        box(0.4, 0.035, 0.035, 0, 0.2, 0, "#1F4E8C"),
        box(0.06, 0.12, 0.12, -0.2, 0.03, 0, "#1F4E8C"),
        box(0.06, 0.12, 0.12, 0.2, 0.03, 0, "#1F4E8C"),
        box(0.035, 0.2, 0.035, -0.2, 0.12, 0, "#1F4E8C"),
        box(0.035, 0.2, 0.035, 0.2, 0.12, 0, "#1F4E8C"),
      ]);
    case "cap":
      return merge([box(0.4, 0.09, 0.4, 0, 0.2, 0, "#B3261E"), box(0.3, 0.025, 0.2, 0, 0.17, 0.26, "#B3261E")]);
    case "antenna":
      return merge([box(0.02, 0.2, 0.02, 0, 0.27, 0, "#222B38"), { geometry: place(new SphereGeometry(0.05, 6, 4), 0, 0.4, 0), color: "#C2410C" }]);
    case "tie":
      return merge([box(0.08, 0.28, 0.03, 0, 0.3, 0.205, "#8A5A00"), box(0.12, 0.05, 0.03, 0, 0.45, 0.2, "#8A5A00")]);
  }
}

/** A pole with a small flag whose shape depends on the status, so status can be read without colour. */
export function pennantGeometry(status: AgentStatus): BufferGeometry {
  const flag = "#FFFFFF";
  const triangle = (pts: [number, number][]) => {
    const s = new Shape();
    pts.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
    return new ShapeGeometry(s);
  };
  const parts: Part[] = [box(0.02, 0.5, 0.02, 0, 0.25, 0, "#444B57")];
  switch (status) {
    case "working":
      parts.push({ geometry: triangle([[0.01, 0.5], [0.01, 0.34], [0.24, 0.42]]), color: flag });
      break;
    case "idle":
      parts.push(box(0.22, 0.05, 0.01, 0.12, 0.44, 0, flag));
      break;
    case "waiting":
      parts.push({ geometry: place(new TorusGeometry(0.075, 0.02, 4, 10), 0.1, 0.43, 0), color: flag });
      break;
    case "done":
      parts.push(box(0.05, 0.12, 0.01, 0.06, 0.4, 0, flag, 0, -0.7), box(0.05, 0.2, 0.01, 0.13, 0.43, 0, flag, 0, 0.7));
      break;
    case "stopped":
      parts.push(box(0.14, 0.14, 0.01, 0.09, 0.43, 0, flag));
      break;
    case "error":
      parts.push({ geometry: triangle([[0.01, 0.5], [0.23, 0.5], [0.12, 0.33]]), color: flag });
      break;
    case "detached":
      parts.push(
        box(0.14, 0.02, 0.01, 0.09, 0.5, 0, flag),
        box(0.14, 0.02, 0.01, 0.09, 0.36, 0, flag),
        box(0.02, 0.14, 0.01, 0.02, 0.43, 0, flag),
        box(0.02, 0.14, 0.01, 0.16, 0.43, 0, flag),
      );
      break;
  }
  return merge(parts); // drawn with a double-sided material so the flag shows from any angle
}

export const flatRing = (inner: number, outer: number) => place(new RingGeometry(inner, outer, 48), 0, 0, 0, -Math.PI / 2);
export const flatPlane = (w: number, d: number) => place(new PlaneGeometry(w, d), 0, 0, 0, -Math.PI / 2);
export const beaconGeometry = () => place(new ConeGeometry(0.09, 0.22, 8), 0, 0.11, 0);
export const unitBox = () => new BoxGeometry(1, 1, 1);

/** A potted plant, about 1 m tall. */
export function plantGeometry(): BufferGeometry {
  return merge([
    { geometry: place(new CylinderGeometry(0.28, 0.2, 0.4, 7), 0, 0.2, 0), color: "#B5673F" },
    { geometry: place(new SphereGeometry(0.42, 6, 5), 0, 0.78, 0), color: "#3F8F5A" },
    { geometry: place(new SphereGeometry(0.28, 6, 5), 0.2, 1.05, 0.05), color: "#4FA56A" },
  ]);
}

/** A bookshelf against a wall, facing +z, 1.8 m wide. */
export function shelfGeometry(): BufferGeometry {
  const parts: Part[] = [box(1.8, 1.7, 0.4, 0, 0.85, 0, "#8C6B4A")];
  const books = ["#C8553D", "#2E86AB", "#D9A21B", "#8E6BAE", "#4C9A6A", "#D17A9E"];
  for (let row = 0; row < 3; row++) {
    parts.push(box(1.64, 0.04, 0.38, 0, 0.3 + row * 0.55, 0.02, "#6E5238"));
    for (let i = 0; i < 6; i++) parts.push(box(0.2, 0.36, 0.28, -0.7 + i * 0.28, 0.5 + row * 0.55, 0.06, books[(i + row) % books.length] as string));
  }
  return merge(parts);
}

/** A standing lamp with a warm shade. */
export function lampGeometry(): BufferGeometry {
  return merge([
    { geometry: place(new CylinderGeometry(0.18, 0.2, 0.05, 8), 0, 0.025, 0), color: "#2B3340" },
    box(0.05, 1.5, 0.05, 0, 0.78, 0, "#2B3340"),
    { geometry: place(new ConeGeometry(0.3, 0.32, 8, 1, true), 0, 1.6, 0), color: "#F2D58A" },
  ]);
}

/** The hub: a low round dais. */
export const daisGeometry = () => place(new CylinderGeometry(1, 1.06, 1, 48), 0, 0.5, 0);
export const coreGeometry = () => new SphereGeometry(1, 16, 12);
export const torusGeometry = (r: number, tube: number) => place(new TorusGeometry(r, tube, 6, 64), 0, 0, 0, Math.PI / 2);
