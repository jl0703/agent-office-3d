import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  type InstancedMesh,
  type LineSegments,
  Matrix4,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import type { Agent, AgentStatus } from "../../../shared/events.ts";
import { createStory, type StoryFrame, type Walker } from "./story.ts";
import { createAssets, type Assets } from "./assets.ts";
import { familyIndexes, rootOf } from "./families.ts";
import { BUILDING_RECT, ROOM_COLORS, SEAT_COUNT, VISITORS_KEY, seatPoint, seatsOfRoom, type Layout, type Point } from "./building.ts";
import { BENCH_LIMIT, BUSH_LIMIT, TREE_LIMIT, floorTone, furnitureOf, groundsOf, isTall, viewSideOf, wallsOf, WALL_GLASS, WALL_TALL, type ViewSide } from "./buildingParts.ts";
import { AVATAR_PARTS } from "../../../shared/avatar.ts";
import { OUTFIT_TINTED } from "./geometry.ts";
import { lookOfAgent, type Look } from "./look.ts";
import { ALL_ACCESSORIES, FAMILY_COLORS, SCENE, STATUS_COLOR, STATUSES, type Scheme } from "./palette.ts";
import { blendPose, poseFor, type Pose } from "./poses.ts";
import type { Selection } from "./selection.ts";

const N = SEAT_COUNT;
const ROOM_LIMIT = 11; // the Management office, the Meeting room, the Pantry, the Lounge, six departments and Visitors
const WALL_LIMIT = 96;
const FURNITURE_LIMIT = 128;
const GROUNDS = groundsOf();
const MIDDLE: Point = { x: (BUILDING_RECT.minX + BUILDING_RECT.maxX) / 2, z: (BUILDING_RECT.minZ + BUILDING_RECT.maxZ) / 2 };
const ORIGIN: Point = { x: 0, z: 0 };
const NAMED = ALL_ACCESSORIES;
const HAIR_NAMES = Array.from({ length: AVATAR_PARTS.hair }, (_, i) => `hair-${i}`);
const OUTFIT_NAMES = Array.from({ length: AVATAR_PARTS.outfit }, (_, i) => `outfit-${i}`);
const hairCount = HAIR_NAMES.map(() => 0);
const outfitCount = OUTFIT_NAMES.map(() => 0);
const HEAD_SCALE = 1.2; // a friendly, chunky head
const colours = new Map<string, Color>();
/** A colour from its hex text, kept so the frame loop does not parse it again. */
const colourOf = (hex: string): Color => {
  let c = colours.get(hex);
  if (!c) colours.set(hex, (c = new Color(hex)));
  return c;
};

type Slot = { id: string; status: AgentStatus; since: number; appearedAt: number; pose: Pose; look: Look; family: number };
type World = {
  slots: (Slot | null)[];
  byId: Map<string, number>;
  first: boolean;
  /** Rooms of the building, in the order of their instances. */
  rooms: { key: string; focusable: boolean }[];
  pulse: number[];
  /** For each status, the desk numbers drawn in that status's instanced mesh. */
  onScreen: Record<AgentStatus, number[]>;
};

const newWorld = (): World => ({
  slots: Array.from({ length: N }, () => null),
  byId: new Map(),
  first: true,
  rooms: [],
  pulse: Array.from({ length: N }, () => -1),
  onScreen: Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as Record<AgentStatus, number[]>,
});

// Reused objects, so the frame loop allocates nothing.
const ZERO = new Matrix4().makeScale(0, 0, 0);
const m1 = new Matrix4();
const m2 = new Matrix4();
const m3 = new Matrix4();
const m4 = new Matrix4();
const m5 = new Matrix4();
const pos = new Vector3();
const one = new Vector3(1, 1, 1);
const scl = new Vector3();
const quat = new Quaternion();
const eul = new Euler();
const tint = new Color();
const mix = new Color();

function compose(out: Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, order: Euler["order"] = "XYZ"): Matrix4 {
  eul.set(rx, ry, rz, order);
  quat.setFromEuler(eul);
  return out.compose(pos.set(x, y, z), quat, scl.set(sx, sy, sz));
}

const smooth = (p: number) => p * p * (3 - 2 * p);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export type OfficeProps = {
  agents: readonly Agent[];
  scheme: Scheme;
  /** Static poses, no camera easing: the user asked for less motion. */
  reduced: boolean;
  /** The connection is down: show the last known state without moving. */
  frozen: boolean;
  selection: Selection;
  tagRefs: MutableRefObject<Map<string, HTMLElement>>;
  /** The building and where everyone sits in it. */
  layout: Layout;
  /** How each agent looks, by id; one that is missing gets the look its id gives. */
  looks: ReadonlyMap<string, Look>;
  /** The room signs, positioned over the scene by the frame loop. */
  roomRefs: MutableRefObject<Map<string, HTMLElement>>;
  /** The speech bubbles: a few elements the frame loop fills in and places. */
  bubbleRefs: MutableRefObject<(HTMLElement | null)[]>;
};

export function Office({ agents, scheme, reduced, frozen, selection, tagRefs, layout, looks, roomRefs, bubbleRefs }: OfficeProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [assets, setAssets] = useState<Assets | null>(null);
  useEffect(() => {
    const made = createAssets(scheme);
    setAssets(made);
    return () => made.dispose();
  }, [scheme]);

  const meshes = useRef<Record<string, Object3D | null>>({});
  const bind = useCallback((name: string) => (node: Object3D | null) => void (meshes.current[name] = node), []);
  const world = useRef<World>(newWorld());
  const story = useRef(createStory());
  const walking = useRef(new Set<number>());
  const assignment = layout.placement;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // The desks are wherever the building puts them: worked out again only when the building changes.
  const seatsRef = useRef<Point[]>([]);
  seatsRef.current = useMemo(() => Array.from({ length: N }, (_, i) => seatPoint(layout.building, i) ?? ORIGIN), [layout.building]);
  const deskPosition = (seat: number): Point => seatsRef.current[seat] ?? ORIGIN;
  const assignmentRef = useRef(assignment);
  assignmentRef.current = assignment;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const looksRef = useRef(looks);
  looksRef.current = looks;
  const clock = useThree((s) => s.clock);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new Color(SCENE[scheme].canvas);
    invalidate();
  }, [scene, scheme, invalidate]);

  const instanced = (name: string) => meshes.current[name] as InstancedMesh | null | undefined;

  // The walls on the far side of each room stand tall and those on the camera's side are low glass, so they follow the view.
  const wallSide = useRef<ViewSide>({ x: 1, z: 1 });
  const placeWalls = useCallback(() => {
    const tallMesh = instanced("wallsTall");
    const glassMesh = instanced("wallsGlass");
    const tone = new Color(scheme === "dark" ? "#3a4250" : "#d9d2c3");
    let tall = 0;
    let glass = 0;
    for (const wall of wallsOf(layoutRef.current.building)) {
      const up = isTall(wall, wallSide.current);
      const i = up ? tall++ : glass++;
      if (i >= WALL_LIMIT) continue;
      const h = up ? WALL_TALL : WALL_GLASS;
      (up ? tallMesh : glassMesh)?.setMatrixAt(i, compose(m1, wall.x, h / 2, wall.z, 0, 0, 0, wall.w, h, wall.d));
      if (up) tallMesh?.setColorAt(i, tone);
    }
    for (const [mesh, n] of [[tallMesh, tall], [glassMesh, glass]] as const) {
      if (!mesh) continue;
      mesh.count = Math.min(n, WALL_LIMIT);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // Lets the browser tests see the walls change over as the view turns.
    document.documentElement.dataset["walls"] = `${tall}/${glass}`;
  }, [scheme]);

  // ---- Static part: everything that only changes when agents arrive, leave, or change status ----
  const rebuild = useCallback(
    () => {
      const w = world.current;
      const sel = selection.get();
      const c = SCENE[scheme];
      const floorColor = tint.set(c.floor).clone();

      for (const s of STATUSES) w.onScreen[s].length = 0;
      const set = (name: string, i: number, m: Matrix4) => instanced(name)?.setMatrixAt(i, m);

      const outline: number[] = [];
      // An empty desk is marked by a dim outline in every room that is in use: the Management office and the departments always, Visitors once someone sits there.
      const outlined = new Set<number>();
      const visitorsUsed = [...assignmentRef.current.roomOf.values()].includes(VISITORS_KEY);
      for (const room of layoutRef.current.building.rooms) if (room.kind !== "visitors" || visitorsUsed) for (const s of seatsOfRoom(layoutRef.current.building, room.key)) outlined.add(s);
      for (let d = 0; d < N; d++) {
        const slot = w.slots[d];
        const { x, z } = deskPosition(d);
        if (!slot) {
          for (const name of ["desks", "monitors", "stripes", "shadows", "hit", "chairs", "torsos", "heads", "armsL", "armsR", "legs"]) set(name, d, ZERO);
          if (outlined.has(d)) {
            // A dim outline marks an empty desk.
            const [x0, x1, z0, z1] = [x - 0.75, x + 0.75, z - 0.4, z + 0.4];
            outline.push(x0, 0.01, z0, x1, 0.01, z0, x1, 0.01, z0, x1, 0.01, z1, x1, 0.01, z1, x0, 0.01, z1, x0, 0.01, z1, x0, 0.01, z0);
          }
          continue;
        }
        const ghost = slot.status === "detached" ? 0.55 : 0;
        set("desks", d, compose(m1, x, 0, z));
        set("monitors", d, compose(m1, x + 0.55, 0.8, z + 0.12, 0, -0.6, 0));
        set("stripes", d, compose(m1, x, 0.803, z + 0.2));
        set("shadows", d, compose(m1, x, 0.012, z - 0.3, 0, 0, 0, 2.3, 1, 3.1));
        set("hit", d, compose(m1, x, 0.9, z - 0.35, 0, 0, 0, 1.9, 1.8, 2.2));
        set("legs", d, compose(m1, x, 0, z - 0.75));
        instanced("desks")?.setColorAt(d, mix.set("#ffffff").lerp(floorColor, ghost));
        instanced("stripes")?.setColorAt(d, tint.set(FAMILY_COLORS[slot.family % FAMILY_COLORS.length] as string));
        const body = tint.set(slot.look.outfitColor).lerp(floorColor, ghost);
        for (const name of ["torsos", "armsL", "armsR"]) instanced(name)?.setColorAt(d, body);
        instanced("heads")?.setColorAt(d, mix.set(slot.look.skin).lerp(floorColor, ghost));
        w.onScreen[slot.status].push(d);
      }

      // Per-status meshes: monitor screens, pennants, error beacons.
      for (const s of STATUSES) {
        const list = w.onScreen[s];
        const screens = instanced(`screen-${s}`);
        const flags = instanced(`pennant-${s}`);
        list.forEach((d, i) => {
          const { x, z } = deskPosition(d);
          screens?.setMatrixAt(i, compose(m1, x + 0.55, 0.8, z + 0.12, 0, -0.6, 0));
          flags?.setMatrixAt(i, compose(m1, x - 0.72, 0.8, z + 0.22, 0, 0.25, 0));
        });
        for (const mesh of [screens, flags]) {
          if (!mesh) continue;
          mesh.count = list.length;
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
      const beacons = instanced("beacons");
      w.onScreen.error.forEach((d, i) => {
        const { x, z } = deskPosition(d);
        beacons?.setMatrixAt(i, compose(m1, x + 0.55, 1.58, z + 0.12));
      });
      if (beacons) {
        beacons.count = w.onScreen.error.length;
        beacons.instanceMatrix.needsUpdate = true;
      }

      for (const name of ["desks", "monitors", "stripes", "shadows", "hit", "legs", "torsos", "heads", "armsL", "armsR", "chairs"]) {
        const mesh = instanced(name);
        if (!mesh) continue;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      // Rooms: a floor tile each, a board on the back wall of those along the north, a plant and a lamp; then the walls with their door gaps and the furniture.
      const dark = scheme === "dark";
      const settle = new Color(dark ? "#12161c" : "#f3eee2");
      const building = layoutRef.current.building;
      w.rooms = building.rooms.map((r) => ({ key: r.key, focusable: r.desks.length > 0 }));
      building.rooms.forEach((room, i) => {
        const r = room.rect;
        const cx = (r.minX + r.maxX) / 2;
        const cz = (r.minZ + r.maxZ) / 2;
        const hue = new Color(ROOM_COLORS[room.color % ROOM_COLORS.length] as string);
        set("roomFloors", i, compose(m1, cx, -0.15, cz, 0, 0, 0, r.maxX - r.minX, 0.3, r.maxZ - r.minZ));
        const tone = floorTone(room.kind, scheme);
        instanced("roomFloors")?.setColorAt(i, tone ? new Color(tone).lerp(hue, 0.12) : hue.clone().lerp(settle, dark ? 0.6 : 0.45));
        const northRow = room.door.z === r.maxZ && room.desks.length > 0 && room.kind !== "visitors"; // its back wall is the tall one at the north
        set("roomBoards", i, northRow ? compose(m1, cx - 1.2, 1.75, r.minZ + 0.3, 0, 0, 0, 3.0, 1.1, 0.06) : ZERO);
        set("roomPlants", i, compose(m1, r.minX + 0.45, 0, r.maxZ - 0.5));
        set("roomLamps", i, compose(m1, r.maxX - 0.45, 0, r.maxZ - 0.5));
      });
      placeWalls();
      let pieces = 0;
      for (const room of building.rooms) {
        for (const f of furnitureOf(room)) {
          if (pieces >= FURNITURE_LIMIT) break;
          set("furniture", pieces, compose(m1, f.x, (f.y ?? 0) + f.h / 2, f.z, 0, 0, 0, f.w, f.h, f.d));
          instanced("furniture")?.setColorAt(pieces, mix.set(f.color));
          pieces++;
        }
      }
      // Picking caches a bounding sphere per instanced mesh; rooms and seats move, so forget it.
      for (const name of ["roomFloors", "hit"]) {
        const mesh = instanced(name);
        if (mesh) mesh.boundingSphere = null;
      }
      for (const [name, count] of [["roomFloors", w.rooms.length], ["roomBoards", w.rooms.length], ["roomPlants", w.rooms.length], ["roomLamps", w.rooms.length], ["furniture", pieces]] as const) {
        const mesh = instanced(name);
        if (!mesh) continue;
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      setLines(meshes.current.outlines as LineSegments | undefined, outline);

      // Cables join a session to its subagents. Those in the selected or hovered family are drawn bright.
      const lookup = new Map(agentsRef.current.map((x) => [x.id, x]));
      const cables: number[] = [];
      const hot: number[] = [];
      const family = (id: string | null): string | null => {
        const found = id === null ? undefined : lookup.get(id);
        return found ? rootOf(found, lookup).id : null;
      };
      const focusRoot = family(sel.selected) ?? family(sel.hovered);
      for (const agent of agentsRef.current) {
        const parent = agent.parentId ? lookup.get(agent.parentId) : undefined;
        if (parent && assignmentRef.current.roomOf.get(agent.id) !== assignmentRef.current.roomOf.get(parent.id)) continue; // cables stay inside a room
        const ps = parent ? w.byId.get(parent.id) : undefined;
        const qs = w.byId.get(agent.id);
        if (ps === undefined || qs === undefined) continue;
        const p = deskPosition(ps);
        const q = deskPosition(qs);
        const line = [p.x, 0.05, p.z, q.x, 0.05, q.z];
        (focusRoot !== null && family(agent.id) === focusRoot ? hot : cables).push(...line);
      }
      setLines(meshes.current.cables as LineSegments | undefined, cables);
      setLines(meshes.current.cablesHot as LineSegments | undefined, hot);
    },
    [scheme, selection, placeWalls],
  );

  // The lawn's trees, bushes and benches: the same every time, placed once. The hair and outfit meshes that are tinted get their colour buffer now, so the first agent to use a style does not make the shader be built again.
  useLayoutEffect(() => {
    if (!assets) return;
    for (const name of [...HAIR_NAMES, ...OUTFIT_NAMES.filter((_, i) => OUTFIT_TINTED[i])]) instanced(name)?.setColorAt(0, colourOf("#ffffff"));
    const put = (name: string, i: number, x: number, z: number, turn: number, size: number) => instanced(name)?.setMatrixAt(i, compose(m1, x, -0.05, z, 0, turn, 0, size, size, size));
    GROUNDS.trees.forEach((t, i) => {
      put("trees", i, t.x, t.z, i * 2.4, t.scale);
      instanced("treeShadows")?.setMatrixAt(i, compose(m1, t.x + 0.3, -0.03, t.z + 0.3, 0, 0, 0, 3.4 * t.scale, 1, 3.4 * t.scale));
    });
    GROUNDS.bushes.forEach((b, i) => put("bushes", i, b.x, b.z, i * 1.3, 0.9 + (i % 3) * 0.2));
    GROUNDS.benches.forEach((b, i) => put("benches", i, b.x, b.z, i === 0 ? Math.PI / 2 : -Math.PI / 2, 1));
    for (const [name, n] of [["trees", GROUNDS.trees.length], ["treeShadows", GROUNDS.trees.length], ["bushes", GROUNDS.bushes.length], ["benches", GROUNDS.benches.length]] as const) {
      const mesh = instanced(name);
      if (!mesh) continue;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
    invalidate();
  }, [assets, invalidate]);

  // ---- Follow the agents ----
  useLayoutEffect(() => {
    if (!assets) return;
    const w = world.current;
    const t = clock.elapsedTime;
    const byDesk = new Map<number, Agent>();
    for (const a of agents) {
      const seat = assignment.seat.get(a.id);
      if (seat !== undefined) byDesk.set(seat, a);
    }
    const families = familyIndexes(agents, FAMILY_COLORS.length);

    const instant = w.first && agents.length > 0; // the first picture shows everyone already seated
    const next: (Slot | null)[] = [];
    for (let d = 0; d < N; d++) {
      const a = byDesk.get(d);
      if (!a) {
        next.push(null);
        w.pulse[d] = -1;
        continue;
      }
      const prev = w.slots[d];
      const family = families.get(a.id) ?? 0;
      if (prev && prev.id === a.id) {
        prev.look = looksRef.current.get(a.id) ?? prev.look; // the owner may have redrawn the picture
        if (prev.status !== a.status) {
          prev.status = a.status;
          prev.since = t;
          w.pulse[d] = t;
        }
        prev.family = family;
        next.push(prev);
      } else {
        next.push({
          id: a.id,
          status: a.status,
          since: instant ? -100 : t,
          appearedAt: instant ? -100 : t,
          pose: poseFor(a.status, 0, 100, true),
          look: looksRef.current.get(a.id) ?? lookOfAgent(a, []),
          family,
        });
        w.pulse[d] = -1;
      }
    }
    w.slots = next;
    w.byId = new Map(next.flatMap((s, d) => (s ? [[s.id, d] as const] : [])));
    if (agents.length > 0) w.first = false;
    story.current.observe(agents, assignment.seat, performance.now(), { reduced, frozen, building: layout.building });
    // With frames on demand, nothing redraws to take a bubble down: ask for one when it is due.
    const redraw = reduced ? setTimeout(invalidate, 2200) : undefined;
    rebuild();
    invalidate();
    return () => clearTimeout(redraw);
  }, [assets, agents, looks, layout, assignment, clock, rebuild, invalidate, reduced, frozen]);

  // Bright cables follow the selection.
  useEffect(
    () =>
      selection.subscribe(() => {
        if (assets) rebuild();
        invalidate();
      }),
    [assets, rebuild, selection, invalidate],
  );

  // ---- Every frame ----
  useFrame((state, delta) => {
    if (!assets) return;
    const w = world.current;
    const t = state.clock.elapsedTime;
    const dt = Math.min(delta, 0.1);
    const still = reduced || frozen;
    const c = SCENE[scheme];
    const side = viewSideOf(state.camera.position, MIDDLE);
    if (side.x !== wallSide.current.x || side.z !== wallSide.current.z) {
      wallSide.current = side;
      placeWalls();
    }
    const torsos = instanced("torsos");
    const heads = instanced("heads");
    const armsL = instanced("armsL");
    const armsR = instanced("armsR");
    const chairs = instanced("chairs");
    const accessory = Object.fromEntries(NAMED.map((k) => [k, instanced(`acc-${k}`)])) as Record<string, InstancedMesh | null | undefined>;
    const counts: Record<string, number> = Object.fromEntries(NAMED.map((k) => [k, 0]));
    hairCount.fill(0);
    outfitCount.fill(0);
    // What a character wears: the accessory, the hair on the head and the outfit detail on the torso, each in the mesh for its style.
    const wear = (look: Look, head: Matrix4, torso: Matrix4) => {
      const piece = look.accessory;
      if (piece !== "none") {
        const mesh = accessory[piece];
        const i = counts[piece] ?? 0;
        if (mesh) {
          mesh.setMatrixAt(i, piece === "tie" ? torso : head); // the tie sits on the torso; the others on the head
          counts[piece] = i + 1;
        }
      }
      const hair = instanced(HAIR_NAMES[look.hair] ?? "");
      if (hair) {
        const i = hairCount[look.hair] as number;
        hair.setMatrixAt(i, head);
        hair.setColorAt(i, colourOf(look.hairColor));
        hairCount[look.hair] = i + 1;
      }
      const outfit = instanced(OUTFIT_NAMES[look.outfit] ?? "");
      if (outfit) {
        const i = outfitCount[look.outfit] as number;
        outfit.setMatrixAt(i, torso);
        if (OUTFIT_TINTED[look.outfit]) outfit.setColorAt(i, colourOf(look.outfitColor));
        outfitCount[look.outfit] = i + 1;
      }
    };
    if (!torsos || !heads || !armsL || !armsR || !chairs) return;
    const nowMs = performance.now();
    const told: StoryFrame = frozen ? { walkers: [], bubbles: [] } : story.current.frame(nowMs);
    const walkerOf = new Map<string, Walker>(told.walkers.map((x) => [x.agentId, x]));
    const walkLegs = instanced("walkLegs");
    // Lets the browser tests (and curious people) see how many are out walking; written only when it changes.
    if (document.documentElement.dataset["walkers"] !== String(told.walkers.length)) document.documentElement.dataset["walkers"] = String(told.walkers.length);
    let legCount = 0;

    for (let d = 0; d < N; d++) {
      const slot = w.slots[d];
      if (!slot) continue;
      const target = poseFor(slot.status, t, t - slot.since, still);
      slot.pose = still ? target : blendPose(slot.pose, target, dt);
      const p = slot.pose;
      const arrived = still ? 1 : smooth(clamp01((t - slot.appearedAt) / 0.7)); // the sit-down
      const { x, z } = deskPosition(d);
      const away = walkerOf.get(slot.id);
      const legsMesh = instanced("legs");
      if (away) {
        // Standing and walking: the same figure, off its seat.
        walking.current.add(d);
        const swing = away.moving ? Math.sin(t * 8) : 0;
        const bob = away.moving ? Math.abs(Math.sin(t * 8)) * 0.03 : 0;
        compose(m1, away.x, 0.8 + bob, away.z, 0.06, away.heading, 0, 1, 1, 1, "YXZ");
        torsos.setMatrixAt(d, m1);
        m2.multiplyMatrices(m1, compose(m4, 0, 0.77, 0, 0, 0, 0, HEAD_SCALE, HEAD_SCALE, HEAD_SCALE, "YXZ"));
        heads.setMatrixAt(d, m2);
        armsL.setMatrixAt(d, m3.multiplyMatrices(m1, compose(m4, 0.26, 0.42, 0, -0.7 * swing, 0, 0.05, 1, 1, 1, "ZXY")));
        armsR.setMatrixAt(d, m3.multiplyMatrices(m1, compose(m4, -0.26, 0.42, 0, 0.7 * swing, 0, -0.05, 1, 1, 1, "ZXY")));
        legsMesh?.setMatrixAt(d, ZERO);
        chairs.setMatrixAt(d, compose(m3, x, 0, z - 0.8 - 0.3));
        if (walkLegs && legCount < 8) {
          compose(m3, away.x, 0.8 + bob, away.z, 0, away.heading, 0);
          walkLegs.setMatrixAt(legCount++, m5.multiplyMatrices(m3, compose(m4, 0.11, 0, 0, 0.8 * swing, 0, 0)));
          walkLegs.setMatrixAt(legCount++, m5.multiplyMatrices(m3, compose(m4, -0.11, 0, 0, -0.8 * swing, 0, 0)));
        }
        wear(slot.look, m2, m1);
        continue;
      }
      if (walking.current.delete(d) && legsMesh) {
        legsMesh.setMatrixAt(d, compose(m3, x, 0, z - 0.75)); // back in the seat
        legsMesh.instanceMatrix.needsUpdate = true;
      }

      const charZ = z - 0.75 - (1 - arrived) * 0.5;
      // Hips, then torso leaning forward. m1 is the torso without breathing scale.
      compose(m1, x, 0.55 + p.bob, charZ, p.lean, 0, 0);
      torsos.setMatrixAt(d, m3.copy(m1).scale(one.set(1, p.breathe, 1))); // breathing scales the torso after the lean
      // Head, on top of the torso.
      m2.multiplyMatrices(m1, compose(m4, 0, 0.77, 0, p.headPitch, p.headYaw, 0, HEAD_SCALE, HEAD_SCALE, HEAD_SCALE, "YXZ"));
      heads.setMatrixAt(d, m2);
      // Arms hang from the shoulders and turn forward (negative) and outward (roll).
      armsL.setMatrixAt(d, m3.multiplyMatrices(m1, compose(m4, 0.26, 0.42, 0, p.armL, 0, p.rollL, 1, 1, 1, "ZXY")));
      armsR.setMatrixAt(d, m3.multiplyMatrices(m1, compose(m4, -0.26, 0.42, 0, p.armR, 0, -p.rollR, 1, 1, 1, "ZXY")));
      // The chair rolls back for a stopped worker, and in from the side when someone arrives.
      chairs.setMatrixAt(d, compose(m3, x, 0, z - 0.8 - p.chairBack - (1 - arrived) * 0.9));

      wear(slot.look, m2, m1);
    }
    for (const kind of NAMED) {
      const mesh = accessory[kind];
      if (!mesh) continue;
      mesh.count = counts[kind] ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [names, used] of [[HAIR_NAMES, hairCount], [OUTFIT_NAMES, outfitCount]] as const) {
      names.forEach((name, style) => {
        const mesh = instanced(name);
        if (!mesh) return;
        mesh.count = used[style] as number;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
    }
    for (const mesh of [torsos, heads, armsL, armsR, chairs]) mesh.instanceMatrix.needsUpdate = true;
    if (walkLegs) {
      walkLegs.count = legCount;
      walkLegs.instanceMatrix.needsUpdate = true;
    }
    const seatedLegs = instanced("legs");
    if (seatedLegs && walkerOf.size > 0) seatedLegs.instanceMatrix.needsUpdate = true;

    // Small effects: monitors and beacons.
    if (!still) {
      assets.screenTextures.working.offset.y = (t * 0.2) % 1;
      assets.mat.screens.idle.color.setScalar(Math.floor(t) % 2 === 0 ? 1 : 0.6);
      assets.mat.beacon.color.set(STATUS_COLOR[scheme].error).multiplyScalar(0.8 + 0.2 * Math.sin(t * Math.PI * 2));
    } else {
      assets.mat.screens.idle.color.setScalar(1);
      assets.mat.beacon.color.set(STATUS_COLOR[scheme].error);
    }

    // Rings: the selected desk, the hovered desk, and a ring that appears when a status changes.
    const sel = selection.get();
    const ring = (name: string, id: string | null) => {
      const mesh = instanced(name);
      if (!mesh) return;
      const d = id === null ? undefined : w.byId.get(id);
      if (d === undefined) {
        mesh.count = 0;
        return;
      }
      const { x, z } = deskPosition(d);
      mesh.count = 1;
      mesh.setMatrixAt(0, compose(m1, x, 0.02, z - 0.35, 0, 0, 0, 1.25, 1, 1.55));
      mesh.instanceMatrix.needsUpdate = true;
    };
    ring("ring-selected", sel.selected);
    ring("ring-hover", sel.hovered !== sel.selected ? sel.hovered : null);

    const pulses = instanced("pulses");
    if (pulses) {
      let n = 0;
      const life = still ? 2 : 0.9;
      for (let d = 0; d < N; d++) {
        const started = w.pulse[d] as number;
        const slot = w.slots[d];
        if (!slot || started < 0 || t - started > life) continue;
        const age = (t - started) / life;
        const { x, z } = deskPosition(d);
        const grow = still ? 1.15 : 1 + 0.6 * age;
        pulses.setMatrixAt(n, compose(m1, x, 0.025, z - 0.35, 0, 0, 0, 1.25 * grow, 1, 1.55 * grow));
        pulses.setColorAt(n, tint.set(STATUS_COLOR[scheme][slot.status]).lerp(mix.set(c.floor), still ? 0 : age));
        n++;
      }
      pulses.count = n;
      pulses.instanceMatrix.needsUpdate = true;
      if (pulses.instanceColor) pulses.instanceColor.needsUpdate = true;
    }

    // Name tags are plain page elements; move them over their characters.
    const { camera, size } = state;
    const total = w.byId.size;
    for (const [id, d] of w.byId) {
      const el = tagRefs.current.get(id);
      const slot = w.slots[d];
      if (!el || !slot) continue;
      const { x, z } = deskPosition(d);
      const away = walkerOf.get(id);
      if (away) pos.set(away.x, 1.95, away.z).project(camera);
      else pos.set(x, 1.95, z - 0.75).project(camera);
      const visible = pos.z < 1 && Math.abs(pos.x) < 1.2 && Math.abs(pos.y) < 1.2 && (total <= 6 || sel.selected === id || sel.hovered === id || (sel.room !== null && assignmentRef.current.roomOf.get(id) === sel.room));
      if (visible) {
        el.style.transform = `translate(${((pos.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-pos.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
        el.style.display = "";
      } else if (el.style.display !== "none") {
        el.style.display = "none";
      }
      const state2 = sel.selected === id ? "selected" : sel.hovered === id ? "hover" : "";
      if (el.dataset.state !== state2) el.dataset.state = state2;
    }

    // Speech bubbles: plain text in a few elements, over the speaker (who may be walking).
    const placed: { x: number; y: number; w: number }[] = [];
    told.bubbles.forEach((b, i) => {
      const el = bubbleRefs.current[i];
      const d = w.byId.get(b.agentId);
      if (!el) return;
      if (d === undefined) {
        el.style.display = "none";
        return;
      }
      const away = walkerOf.get(b.agentId);
      const seat = deskPosition(d);
      pos.set(away ? away.x : seat.x, 2.45, away ? away.z : seat.z - 0.75).project(camera);
      if (el.dataset.text !== b.text) {
        el.dataset.text = b.text;
        el.textContent = b.text;
      }
      // Two bubbles close together would cover each other: lift the later one clear of the earlier ones.
      const sx = (pos.x * 0.5 + 0.5) * size.width;
      let sy = (-pos.y * 0.5 + 0.5) * size.height;
      const width = Math.min(288, 7 * b.text.length + 18);
      for (let tries = 0; tries < 4; tries++) {
        const clash = placed.some((p) => Math.abs(p.x - sx) < (p.w + width) / 2 && Math.abs(p.y - sy) < 28);
        if (!clash) break;
        sy -= 28;
      }
      if (pos.z < 1) placed.push({ x: sx, y: sy, w: width }); // one behind the camera takes no room
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      el.style.display = pos.z < 1 ? "" : "none";
    });
    for (let i = told.bubbles.length; i < bubbleRefs.current.length; i++) {
      const el = bubbleRefs.current[i];
      if (el && el.style.display !== "none") el.style.display = "none";
    }

    // Room signs sit above each room's back wall.
    for (const room of layoutRef.current.building.rooms) {
      const el = roomRefs.current.get(room.key);
      if (!el) continue;
      pos.set((room.rect.minX + room.rect.maxX) / 2, 2.9, room.rect.minZ + 0.2).project(camera);
      if (pos.z < 1 && Math.abs(pos.x) < 1.3 && Math.abs(pos.y) < 1.3) {
        el.style.transform = `translate(${((pos.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-pos.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
        el.style.display = "";
      } else if (el.style.display !== "none") {
        el.style.display = "none";
      }
    }
  });

  if (!assets) return null;
  const { geo, mat } = assets;

  const hit = (e: { stopPropagation(): void; instanceId?: number }) => {
    const d = e.instanceId;
    return d === undefined ? undefined : world.current.slots[d]?.id;
  };

  return (
    <group>
      <hemisphereLight args={[scheme === "light" ? "#eef5ff" : "#9fb4d6", scheme === "light" ? "#b9a98a" : "#2a323d", scheme === "light" ? 1.1 : 0.9]} />
      <directionalLight color={scheme === "light" ? "#fff0d2" : "#b8c8ff"} position={[-8, 14, 10]} intensity={scheme === "light" ? 1.5 : 1.1} />

      <mesh position={[(GROUNDS.lawn.minX + GROUNDS.lawn.maxX) / 2, -0.2, (GROUNDS.lawn.minZ + GROUNDS.lawn.maxZ) / 2]} scale={[GROUNDS.lawn.maxX - GROUNDS.lawn.minX, 0.3, GROUNDS.lawn.maxZ - GROUNDS.lawn.minZ]} geometry={geo.box} material={mat.lawn} />
      <mesh position={[(GROUNDS.path.minX + GROUNDS.path.maxX) / 2, -0.05, (GROUNDS.path.minZ + GROUNDS.path.maxZ) / 2]} scale={[GROUNDS.path.maxX - GROUNDS.path.minX, 0.04, GROUNDS.path.maxZ - GROUNDS.path.minZ]} geometry={geo.box} material={mat.path} />
      <instancedMesh ref={bind("treeShadows")} args={[geo.shadow, mat.shadow, TREE_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("trees")} args={[geo.tree, mat.vertex, TREE_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("bushes")} args={[geo.bush, mat.vertex, BUSH_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("benches")} args={[geo.bench, mat.vertex, BENCH_LIMIT]} frustumCulled={false} />

      <mesh position={[(BUILDING_RECT.minX + BUILDING_RECT.maxX) / 2, -0.17, (BUILDING_RECT.minZ + BUILDING_RECT.maxZ) / 2]} scale={[BUILDING_RECT.maxX - BUILDING_RECT.minX + 0.6, 0.3, BUILDING_RECT.maxZ - BUILDING_RECT.minZ + 0.6]} geometry={geo.box} material={mat.ground} />
      <instancedMesh
        ref={bind("roomFloors")}
        args={[geo.box, mat.room, ROOM_LIMIT]}
        frustumCulled={false}
        onClick={(e) => {
          const room = e.instanceId === undefined ? undefined : world.current.rooms[e.instanceId];
          if (room?.focusable) {
            // The shared rooms hold no desks, so there is no list of sessions to filter to.
            e.stopPropagation();
            selection.focusRoom(selection.get().room === room.key ? null : room.key);
          }
        }}
      />
      <instancedMesh ref={bind("wallsTall")} args={[geo.box, mat.room, WALL_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("wallsGlass")} args={[geo.box, mat.glass, WALL_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("furniture")} args={[geo.box, mat.room, FURNITURE_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("roomBoards")} args={[geo.box, mat.board, ROOM_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("roomPlants")} args={[geo.plant, mat.vertex, ROOM_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("roomLamps")} args={[geo.lamp, mat.vertex, ROOM_LIMIT]} frustumCulled={false} />
      <instancedMesh ref={bind("walkLegs")} args={[geo.walkLeg, mat.vertex, 8]} frustumCulled={false} />

      <lineSegments ref={bind("outlines")} material={mat.outline}>
        <bufferGeometry />
      </lineSegments>
      <lineSegments ref={bind("cables")} material={mat.cable}>
        <bufferGeometry />
      </lineSegments>
      <lineSegments ref={bind("cablesHot")} material={mat.cableHot}>
        <bufferGeometry />
      </lineSegments>

      <instancedMesh ref={bind("shadows")} args={[geo.shadow, mat.shadow, N]} frustumCulled={false} />
      <instancedMesh ref={bind("desks")} args={[geo.desk, mat.vertex, N]} frustumCulled={false} />
      <instancedMesh ref={bind("stripes")} args={[geo.stripe, mat.stripe, N]} frustumCulled={false} />
      <instancedMesh ref={bind("chairs")} args={[geo.chair, mat.vertex, N]} frustumCulled={false} />
      <instancedMesh ref={bind("monitors")} args={[geo.monitor, mat.vertex, N]} frustumCulled={false} />
      <instancedMesh ref={bind("legs")} args={[geo.legs, mat.vertex, N]} frustumCulled={false} />
      <instancedMesh ref={bind("torsos")} args={[geo.torso, mat.person, N]} frustumCulled={false} />
      <instancedMesh ref={bind("heads")} args={[geo.head, mat.vertex, N]} frustumCulled={false} />
      <instancedMesh ref={bind("armsL")} args={[geo.arm, mat.person, N]} frustumCulled={false} />
      <instancedMesh ref={bind("armsR")} args={[geo.arm, mat.person, N]} frustumCulled={false} />
      {NAMED.map((k) => (
        <instancedMesh key={k} ref={bind(`acc-${k}`)} args={[geo.accessories[k], mat.vertex, N]} frustumCulled={false} />
      ))}
      {geo.hair.map((g, i) => g && <instancedMesh key={HAIR_NAMES[i]} ref={bind(HAIR_NAMES[i] as string)} args={[g, mat.vertex, N]} frustumCulled={false} />)}
      {geo.outfit.map((g, i) => g && <instancedMesh key={OUTFIT_NAMES[i]} ref={bind(OUTFIT_NAMES[i] as string)} args={[g, mat.vertex, N]} frustumCulled={false} />)}
      {STATUSES.map((s) => (
        <instancedMesh key={`screen-${s}`} ref={bind(`screen-${s}`)} args={[geo.screen, mat.screens[s], N]} frustumCulled={false} />
      ))}
      {STATUSES.map((s) => (
        <instancedMesh key={`pennant-${s}`} ref={bind(`pennant-${s}`)} args={[geo.pennants[s], mat.pennants[s], N]} frustumCulled={false} />
      ))}
      <instancedMesh ref={bind("beacons")} args={[geo.beacon, mat.beacon, N]} frustumCulled={false} />
      <instancedMesh ref={bind("pulses")} args={[geo.ringSoft, mat.pulse, N]} frustumCulled={false} />
      <instancedMesh ref={bind("ring-selected")} args={[geo.ring, mat.selected, 1]} frustumCulled={false} />
      <instancedMesh ref={bind("ring-hover")} args={[geo.ring, mat.hover, 1]} frustumCulled={false} />
      <instancedMesh
        ref={bind("hit")}
        args={[geo.box, mat.hit, N]}
        frustumCulled={false}
        onPointerMove={(e) => {
          const id = hit(e);
          if (id) {
            e.stopPropagation();
            selection.hover(id);
            document.body.style.cursor = "pointer";
          }
        }}
        onPointerOut={() => {
          selection.hover(null);
          document.body.style.cursor = "";
        }}
        onClick={(e) => {
          const id = hit(e);
          if (id) {
            e.stopPropagation();
            selection.select(id);
          }
        }}
      />
    </group>
  );
}

function setLines(lines: LineSegments | undefined, points: number[]) {
  if (!lines) return;
  lines.geometry.dispose();
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(points, 3));
  lines.geometry = g;
}
