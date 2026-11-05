import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
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
import { graphLayout, MAX_GRAPH_NODES, type Vault } from "../vault.ts";
import { createAssets, type Assets } from "./assets.ts";
import { familyIndexes, rootOf } from "./families.ts";
import { HUB_RADIUS, ROOM_COLORS, ROOM_D, ROOM_W, MAX_ROOMS, SEATS_PER_ROOM, SEAT_COUNT, roadSegment, roomCenter, seatPosition, type Assignment } from "./rooms.ts";
import { ACCESSORIES, CHARACTER_COLORS, FAMILY_COLORS, SCENE, STATUS_COLOR, STATUSES, characterStyle, type Accessory, type Scheme } from "./palette.ts";
import { blendPose, poseFor, type Pose } from "./poses.ts";
import type { Selection } from "./selection.ts";

const N = SEAT_COUNT;
const SEAT_POS = Array.from({ length: N }, (_, i) => seatPosition(i));
const deskPosition = (seat: number) => SEAT_POS[seat] as { x: number; z: number };
const NAMED: readonly Exclude<Accessory, "none">[] = ACCESSORIES.filter((a): a is Exclude<Accessory, "none"> => a !== "none");

type Slot = { id: string; status: AgentStatus; since: number; appearedAt: number; pose: Pose; color: number; accessory: Accessory; family: number };
type World = {
  slots: (Slot | null)[];
  byId: Map<string, number>;
  first: boolean;
  /** Rooms in use, in the order of their instances. */
  rooms: { key: string; slot: number }[];
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
  assignment: Assignment;
  /** The connected vault, drawn as notes orbiting the hub; null when there is none. */
  vault: Vault | null;
  /** The hub's sign, positioned over the scene by the frame loop. */
  hubRef: MutableRefObject<HTMLElement | null>;
  /** The room signs, positioned over the scene by the frame loop. */
  roomRefs: MutableRefObject<Map<string, HTMLElement>>;
  /** The speech bubbles: a few elements the frame loop fills in and places. */
  bubbleRefs: MutableRefObject<(HTMLElement | null)[]>;
};

export function Office({ agents, scheme, reduced, frozen, selection, tagRefs, assignment, roomRefs, vault, hubRef, bubbleRefs }: OfficeProps) {
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
  const assignmentRef = useRef(assignment);
  assignmentRef.current = assignment;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const clock = useThree((s) => s.clock);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new Color(SCENE[scheme].canvas);
    invalidate();
  }, [scene, scheme, invalidate]);

  const instanced = (name: string) => meshes.current[name] as InstancedMesh | null | undefined;

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
      for (let d = 0; d < N; d++) {
        const slot = w.slots[d];
        const { x, z } = deskPosition(d);
        if (!slot) {
          for (const name of ["desks", "monitors", "stripes", "shadows", "hit", "chairs", "torsos", "heads", "armsL", "armsR", "legs"]) set(name, d, ZERO);
          if (w.rooms.some((r) => r.slot === Math.floor(d / SEATS_PER_ROOM))) {
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
        const body = tint.set(CHARACTER_COLORS[slot.color] as string).lerp(floorColor, ghost);
        for (const name of ["torsos", "armsL", "armsR"]) instanced(name)?.setColorAt(d, body);
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

      // Rooms: a floor tile, two walls, a whiteboard and a few props each, and a road from the hub.
      const dark = scheme === "dark";
      const settle = new Color(dark ? "#12161c" : "#f3eee2");
      w.rooms.forEach(({ key, slot }, i) => {
        const at = roomCenter(slot);
        const hue = new Color(ROOM_COLORS[assignmentRef.current.colorOf.get(key) ?? 0] as string);
        set("roomFloors", i, compose(m1, at.x, -0.15, at.z, 0, 0, 0, ROOM_W, 0.3, ROOM_D));
        instanced("roomFloors")?.setColorAt(i, hue.clone().lerp(settle, dark ? 0.6 : 0.45));
        const wall = hue.clone().multiplyScalar(dark ? 0.7 : 1);
        set("roomBack", i, compose(m1, at.x, 1.3, at.z - ROOM_D / 2 + 0.125, 0, 0, 0, ROOM_W, 2.6, 0.25));
        instanced("roomBack")?.setColorAt(i, wall);
        set("roomLeft", i, compose(m1, at.x - ROOM_W / 2 + 0.125, 1.3, at.z, 0, 0, 0, 0.25, 2.6, ROOM_D - 0.25));
        instanced("roomLeft")?.setColorAt(i, wall);
        set("roomBoards", i, compose(m1, at.x, 1.75, at.z - ROOM_D / 2 + 0.28, 0, 0, 0, 3.4, 1.1, 0.06));
        set("roomPlants", i, compose(m1, at.x + ROOM_W / 2 - 0.9, 0, at.z - ROOM_D / 2 + 0.9));
        set("roomShelves", i, compose(m1, at.x - ROOM_W / 2 + 0.45, 0, at.z + 0.8, 0, Math.PI / 2, 0));
        set("roomLamps", i, compose(m1, at.x + ROOM_W / 2 - 0.7, 0, at.z + 0.9));
        const road = roadSegment(slot);
        set("roads", i, compose(m1, road.x, 0.015, road.z, 0, road.angle, 0, 0.7, 0.03, road.length));
      });
      // Picking caches a bounding sphere per instanced mesh; rooms and seats move, so forget it.
      for (const name of ["roomFloors", "hit"]) {
        const mesh = instanced(name);
        if (mesh) mesh.boundingSphere = null;
      }
      for (const name of ["roomFloors", "roomBack", "roomLeft", "roomBoards", "roomPlants", "roomShelves", "roomLamps", "roads"]) {
        const mesh = instanced(name);
        if (!mesh) continue;
        mesh.count = w.rooms.length;
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
    [scheme, selection],
  );

  // The vault's notes: small spheres and thin lines around the core, turned slowly as one group.
  useLayoutEffect(() => {
    if (!assets) return;
    const nodes = instanced("graphNodes");
    const layout = vault ? graphLayout(vault.nodes, vault.links) : { positions: [], sizes: [], lines: [] };
    layout.sizes.forEach((size, i) => {
      nodes?.setMatrixAt(i, compose(m1, layout.positions[i * 3] as number, layout.positions[i * 3 + 1] as number, layout.positions[i * 3 + 2] as number, 0, 0, 0, size, size, size));
    });
    if (nodes) {
      nodes.count = layout.sizes.length;
      nodes.instanceMatrix.needsUpdate = true;
    }
    setLines(meshes.current.graphLines as LineSegments | undefined, layout.lines);
    invalidate();
  }, [assets, vault, invalidate]);

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
        if (prev.status !== a.status) {
          prev.status = a.status;
          prev.since = t;
          w.pulse[d] = t;
        }
        prev.family = family;
        next.push(prev);
      } else {
        const style = characterStyle(a.id);
        next.push({
          id: a.id,
          status: a.status,
          since: instant ? -100 : t,
          appearedAt: instant ? -100 : t,
          pose: poseFor(a.status, 0, 100, true),
          color: style.color,
          accessory: style.accessory,
          family,
        });
        w.pulse[d] = -1;
      }
    }
    w.slots = next;
    w.byId = new Map(next.flatMap((s, d) => (s ? [[s.id, d] as const] : [])));
    if (agents.length > 0) w.first = false;
    story.current.observe(agents, assignment.seat, performance.now(), { reduced, frozen });
    // With frames on demand, nothing redraws to take a bubble down: ask for one when it is due.
    const redraw = reduced ? setTimeout(invalidate, 2200) : undefined;
    w.rooms = [...assignment.roomSlot].map(([key, slot]) => ({ key, slot })).sort((x, y) => x.slot - y.slot);
    rebuild();
    invalidate();
    return () => clearTimeout(redraw);
  }, [assets, agents, assignment, clock, rebuild, invalidate, reduced, frozen]);

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
    const torsos = instanced("torsos");
    const heads = instanced("heads");
    const armsL = instanced("armsL");
    const armsR = instanced("armsR");
    const chairs = instanced("chairs");
    const accessory = Object.fromEntries(NAMED.map((k) => [k, instanced(`acc-${k}`)])) as Record<string, InstancedMesh | null | undefined>;
    const counts: Record<string, number> = Object.fromEntries(NAMED.map((k) => [k, 0]));
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
        m2.multiplyMatrices(m1, compose(m4, 0, 0.74, 0, 0, 0, 0, 1, 1, 1, "YXZ"));
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
        const kindAway = slot.accessory;
        if (kindAway !== "none") {
          const mesh = accessory[kindAway];
          const i = counts[kindAway] ?? 0;
          if (mesh) {
            mesh.setMatrixAt(i, kindAway === "tie" ? m1 : m2);
            counts[kindAway] = i + 1;
          }
        }
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
      m2.multiplyMatrices(m1, compose(m4, 0, 0.74, 0, p.headPitch, p.headYaw, 0, 1, 1, 1, "YXZ"));
      heads.setMatrixAt(d, m2);
      // Arms hang from the shoulders and turn forward (negative) and outward (roll).
      armsL.setMatrixAt(d, m3.multiplyMatrices(m1, compose(m4, 0.26, 0.42, 0, p.armL, 0, p.rollL, 1, 1, 1, "ZXY")));
      armsR.setMatrixAt(d, m3.multiplyMatrices(m1, compose(m4, -0.26, 0.42, 0, p.armR, 0, -p.rollR, 1, 1, 1, "ZXY")));
      // The chair rolls back for a stopped worker, and in from the side when someone arrives.
      chairs.setMatrixAt(d, compose(m3, x, 0, z - 0.8 - p.chairBack - (1 - arrived) * 0.9));

      const kind = slot.accessory;
      if (kind !== "none") {
        const mesh = accessory[kind];
        const i = counts[kind] ?? 0;
        if (mesh) {
          // The tie sits on the torso; the others on the head.
          mesh.setMatrixAt(i, kind === "tie" ? m1 : m2);
          counts[kind] = i + 1;
        }
      }
    }
    for (const kind of NAMED) {
      const mesh = accessory[kind];
      if (!mesh) continue;
      mesh.count = counts[kind] ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
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
    for (const { key, slot } of w.rooms) {
      const el = roomRefs.current.get(key);
      if (!el) continue;
      const at = roomCenter(slot);
      pos.set(at.x, 2.9, at.z - ROOM_D / 2 + 0.2).project(camera);
      if (pos.z < 1 && Math.abs(pos.x) < 1.3 && Math.abs(pos.y) < 1.3) {
        el.style.transform = `translate(${((pos.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-pos.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
        el.style.display = "";
      } else if (el.style.display !== "none") {
        el.style.display = "none";
      }
    }
    const hubRing = meshes.current.hubRing;
    if (hubRing && !still) hubRing.rotation.y = t * 0.25;
    const graph = meshes.current.graph;
    if (graph && !still) graph.rotation.y = t * 0.12;
    const sign = hubRef.current;
    if (sign) {
      pos.set(0, 3.9, 0).project(camera);
      if (pos.z < 1 && Math.abs(pos.x) < 1.3 && Math.abs(pos.y) < 1.3) {
        sign.style.transform = `translate(${((pos.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-pos.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
        sign.style.display = "";
      } else if (sign.style.display !== "none") {
        sign.style.display = "none";
      }
    }
  });

  if (!assets) return null;
  const { geo, mat } = assets;
  const c = SCENE[scheme];

  const hit = (e: { stopPropagation(): void; instanceId?: number }) => {
    const d = e.instanceId;
    return d === undefined ? undefined : world.current.slots[d]?.id;
  };

  return (
    <group>
      <hemisphereLight args={["#ffffff", c.floor, 1.1]} />
      <directionalLight position={[6, 12, 8]} intensity={1.4} />

      <instancedMesh
        ref={bind("roomFloors")}
        args={[geo.box, mat.room, MAX_ROOMS]}
        frustumCulled={false}
        onClick={(e) => {
          const room = e.instanceId === undefined ? undefined : world.current.rooms[e.instanceId];
          if (room) {
            e.stopPropagation();
            selection.focusRoom(selection.get().room === room.key ? null : room.key);
          }
        }}
      />
      <instancedMesh ref={bind("roomBack")} args={[geo.box, mat.room, MAX_ROOMS]} frustumCulled={false} />
      <instancedMesh ref={bind("roomLeft")} args={[geo.box, mat.room, MAX_ROOMS]} frustumCulled={false} />
      <instancedMesh ref={bind("roomBoards")} args={[geo.box, mat.board, MAX_ROOMS]} frustumCulled={false} />
      <instancedMesh ref={bind("roomPlants")} args={[geo.plant, mat.vertex, MAX_ROOMS]} frustumCulled={false} />
      <instancedMesh ref={bind("roomShelves")} args={[geo.shelf, mat.vertex, MAX_ROOMS]} frustumCulled={false} />
      <instancedMesh ref={bind("roomLamps")} args={[geo.lamp, mat.vertex, MAX_ROOMS]} frustumCulled={false} />
      <instancedMesh ref={bind("walkLegs")} args={[geo.walkLeg, mat.vertex, 8]} frustumCulled={false} />
      <instancedMesh ref={bind("roads")} args={[geo.box, mat.road, MAX_ROOMS]} frustumCulled={false} />

      <mesh geometry={geo.dais} material={mat.dais} scale={[HUB_RADIUS, 0.3, HUB_RADIUS]} position={[0, -0.3, 0]} />
      <mesh geometry={geo.core} material={mat.core} scale={0.9} position={[0, 1.7, 0]} />
      <mesh ref={bind("hubRing")} geometry={geo.hubRing} material={mat.hubRing} position={[0, 1.7, 0]} />
      <group ref={bind("graph")} position={[0, 1.7, 0]}>
        <instancedMesh ref={bind("graphNodes")} args={[geo.node, mat.node, MAX_GRAPH_NODES]} frustumCulled={false} />
        <lineSegments ref={bind("graphLines")} material={mat.graphLine} frustumCulled={false}>
          <bufferGeometry />
        </lineSegments>
      </group>
      <mesh geometry={geo.hubRingOuter} material={mat.hubRing} position={[0, 0.04, 0]} />
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
