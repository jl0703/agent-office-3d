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
  type Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import type { Agent, AgentStatus } from "../../../shared/events.ts";
import { createAssets, type Assets } from "./assets.ts";
import { familyIndexes, rootOf } from "./families.ts";
import { VISIBLE_DESKS, deskPosition, floorBounds, rowsFor } from "./layout.ts";
import { ACCESSORIES, CHARACTER_COLORS, FAMILY_COLORS, SCENE, STATUS_COLOR, STATUSES, characterStyle, type Accessory, type Scheme } from "./palette.ts";
import { blendPose, poseFor, type Pose } from "./poses.ts";
import type { Selection } from "./selection.ts";

const N = VISIBLE_DESKS;
const NAMED: readonly Exclude<Accessory, "none">[] = ACCESSORIES.filter((a): a is Exclude<Accessory, "none"> => a !== "none");

type Slot = { id: string; status: AgentStatus; since: number; appearedAt: number; pose: Pose; color: number; accessory: Accessory; family: number };
type World = {
  slots: (Slot | null)[];
  byId: Map<string, number>;
  first: boolean;
  rows: number;
  pulse: number[];
  /** For each status, the desk numbers drawn in that status's instanced mesh. */
  onScreen: Record<AgentStatus, number[]>;
};

const newWorld = (): World => ({
  slots: Array.from({ length: N }, () => null),
  byId: new Map(),
  first: true,
  rows: 1,
  pulse: Array.from({ length: N }, () => -1),
  onScreen: Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as Record<AgentStatus, number[]>,
});

// Reused objects, so the frame loop allocates nothing.
const ZERO = new Matrix4().makeScale(0, 0, 0);
const m1 = new Matrix4();
const m2 = new Matrix4();
const m3 = new Matrix4();
const m4 = new Matrix4();
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
  onRows: (rows: number) => void;
};

export function Office({ agents, scheme, reduced, frozen, selection, tagRefs, onRows }: OfficeProps) {
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
          if (d < w.rows * 6) {
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

      // Floor and grid grow with the number of rows.
      const b = floorBounds(w.rows);
      const width = b.maxX - b.minX;
      const depth = b.maxZ - b.minZ;
      const floor = meshes.current.floor as Mesh | undefined;
      const lip = meshes.current.lip as Mesh | undefined;
      floor?.position.set(0, -0.15, (b.minZ + b.maxZ) / 2);
      floor?.scale.set(width, 0.3, depth);
      lip?.position.set(0, -0.24, (b.minZ + b.maxZ) / 2);
      lip?.scale.set(width + 0.5, 0.18, depth + 0.5);

      const grid: number[] = [];
      for (let gx = Math.ceil(b.minX / 1.2) * 1.2; gx <= b.maxX; gx += 1.2) grid.push(gx, 0.005, b.minZ, gx, 0.005, b.maxZ);
      for (let gz = Math.ceil(b.minZ / 1.2) * 1.2; gz <= b.maxZ; gz += 1.2) grid.push(b.minX, 0.005, gz, b.maxX, 0.005, gz);
      setLines(meshes.current.grid as LineSegments | undefined, grid);
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
        if (!parent || agent.desk >= N || parent.desk >= N) continue;
        const p = deskPosition(parent.desk);
        const q = deskPosition(agent.desk);
        const line = [p.x, 0.05, p.z, q.x, 0.05, q.z];
        (focusRoot !== null && family(agent.id) === focusRoot ? hot : cables).push(...line);
      }
      setLines(meshes.current.cables as LineSegments | undefined, cables);
      setLines(meshes.current.cablesHot as LineSegments | undefined, hot);
    },
    [scheme, selection],
  );

  // ---- Follow the agents ----
  useLayoutEffect(() => {
    if (!assets) return;
    const w = world.current;
    const t = clock.elapsedTime;
    const byDesk = new Map<number, Agent>();
    for (const a of agents) if (a.desk >= 0 && a.desk < N) byDesk.set(a.desk, a);
    const families = familyIndexes(agents, FAMILY_COLORS.length);

    const instant = w.first && agents.length > 0; // the first picture shows everyone already seated
    const next: (Slot | null)[] = [];
    let highest = -1;
    for (let d = 0; d < N; d++) {
      const a = byDesk.get(d);
      if (!a) {
        next.push(null);
        w.pulse[d] = -1;
        continue;
      }
      highest = d;
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
    const rows = rowsFor(highest);
    if (rows !== w.rows) {
      w.rows = rows;
      onRows(rows);
    }
    rebuild();
    invalidate();
  }, [assets, agents, clock, rebuild, onRows, invalidate]);

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

    for (let d = 0; d < N; d++) {
      const slot = w.slots[d];
      if (!slot) continue;
      const target = poseFor(slot.status, t, t - slot.since, still);
      slot.pose = still ? target : blendPose(slot.pose, target, dt);
      const p = slot.pose;
      const arrived = still ? 1 : smooth(clamp01((t - slot.appearedAt) / 0.7)); // the sit-down
      const { x, z } = deskPosition(d);

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
      pos.set(x, 1.95, z - 0.75).project(camera);
      const hot = sel.selected === id || sel.hovered === id || slot.status === "error";
      const visible = pos.z < 1 && Math.abs(pos.x) < 1.2 && Math.abs(pos.y) < 1.2 && (total <= 24 || hot);
      if (visible) {
        el.style.transform = `translate(${((pos.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-pos.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
        el.style.display = "";
      } else if (el.style.display !== "none") {
        el.style.display = "none";
      }
      const state2 = sel.selected === id ? "selected" : sel.hovered === id ? "hover" : "";
      if (el.dataset.state !== state2) el.dataset.state = state2;
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

      <mesh ref={bind("lip")} geometry={geo.box} material={mat.lip} />
      <mesh ref={bind("floor")} geometry={geo.box} material={mat.floor} />
      <lineSegments ref={bind("grid")} material={mat.grid}>
        <bufferGeometry />
      </lineSegments>
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
