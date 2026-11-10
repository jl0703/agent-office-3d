import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef, type KeyboardEvent, type MutableRefObject } from "react";
import { Spherical, Vector3 } from "three";
import type { Agent } from "../../../shared/events.ts";
import { Office } from "./Office.tsx";
import { CAMERA_AZIMUTH, CAMERA_ELEVATION, CAMERA_FOV_DEG, fitCamera, truncateTag } from "./layout.ts";
import { AvatarImage } from "../Avatar.tsx";
import { avatarOf, roleOf, type Person } from "../team.ts";
import { lookOfAgent } from "./look.ts";
import { MAX_BUBBLES } from "./story.ts";
import { overviewBounds, roomBounds, type Bounds, type Layout } from "./building.ts";
import { FAMILY_LETTERS } from "./palette.ts";
import { familyIndexes } from "./families.ts";
import { useReducedMotion, useScheme, webglAvailable } from "./hooks.ts";
import { useSelection, type Selection } from "./selection.ts";

const rad = (deg: number) => (deg * Math.PI) / 180;
const POLAR_MIN = rad(25);
const POLAR_MAX = rad(70);

type RigApi = { reset(): void; orbit(dTheta: number, dPhi: number): void; zoom(factor: number): void };

/** Frames the occupied rows, keeps the user inside sensible limits, and eases between views. */
function CameraRig({ view, limit, focusKey, reduced, api }: { view: Bounds; limit: Bounds; focusKey: string; reduced: boolean; api: MutableRefObject<RigApi | null> }) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const aspect = size.width / Math.max(size.height, 1);
  const goal = useRef({ distance: 30, fit: 30, target: new Vector3(), animating: false, userMoved: false, placed: false });
  const bounds = useRef(limit);
  const lastFocus = useRef(focusKey);

  const place = useCallback(
    (distance: number, target: Vector3) => {
      const offset = new Vector3().setFromSpherical(new Spherical(distance, Math.PI / 2 - CAMERA_ELEVATION, CAMERA_AZIMUTH));
      camera.position.copy(target).add(offset);
      controls.current?.target.copy(target);
      camera.lookAt(target);
      controls.current?.update();
    },
    [camera],
  );

  // Aim at the new framing when the rows or the window shape change, unless the user has taken over.
  useEffect(() => {
    const fit = fitCamera(view, aspect);
    const g = goal.current;
    if (lastFocus.current !== focusKey) {
      lastFocus.current = focusKey;
      g.userMoved = false; // a new room (or the overview) is a request to look there
    }
    g.fit = fit.distance;
    bounds.current = limit;
    if (controls.current) {
      controls.current.minDistance = fit.distance * 0.5;
      controls.current.maxDistance = fit.distance * 1.5;
    }
    if (!g.userMoved) {
      g.distance = fit.distance;
      g.target.set(...fit.target);
      if (reduced || !g.placed) place(g.distance, g.target);
      else g.animating = true;
      g.placed = true;
    }
    invalidate();
  }, [view, limit, focusKey, aspect, reduced, place, invalidate]);

  useEffect(() => {
    const clampPolar = (v: number) => Math.min(POLAR_MAX, Math.max(POLAR_MIN, v));
    const move = (theta: number, phi: number, radius: number) => {
      const c = controls.current;
      if (!c) return;
      const g = goal.current;
      const spherical = new Spherical(Math.min(g.fit * 1.5, Math.max(g.fit * 0.5, radius)), clampPolar(phi), theta);
      camera.position.copy(c.target).add(new Vector3().setFromSpherical(spherical));
      c.update();
      g.userMoved = true;
      g.animating = false;
      invalidate();
    };
    const current = () => new Spherical().setFromVector3(camera.position.clone().sub(controls.current?.target ?? new Vector3()));
    api.current = {
      reset() {
        const g = goal.current;
        g.userMoved = false;
        const fit = fitCamera(view, aspect);
        g.distance = fit.distance;
        g.target.set(...fit.target);
        // Back to the default angle at once; the distance and aim ease in.
        const offset = new Vector3().setFromSpherical(new Spherical(current().radius, Math.PI / 2 - CAMERA_ELEVATION, CAMERA_AZIMUTH));
        camera.position.copy(controls.current?.target ?? g.target).add(offset);
        if (reduced) place(g.distance, g.target);
        else g.animating = true;
        invalidate();
      },
      orbit(dTheta, dPhi) {
        const s = current();
        move(s.theta + dTheta, s.phi + dPhi, s.radius);
      },
      zoom(factor) {
        const s = current();
        move(s.theta, s.phi, s.radius * factor);
      },
    };
    return () => {
      api.current = null;
    };
  }, [api, camera, view, aspect, reduced, place, invalidate]);

  useFrame((_, delta) => {
    const g = goal.current;
    const c = controls.current;
    if (!g.animating || !c) return;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 6); // about 600 ms
    const offset = camera.position.clone().sub(c.target);
    const radius = offset.length();
    const nextRadius = radius + (g.distance - radius) * k;
    c.target.lerp(g.target, k);
    camera.position.copy(c.target).add(offset.normalize().multiplyScalar(nextRadius));
    c.update();
    if (Math.abs(nextRadius - g.distance) < 0.02 && c.target.distanceTo(g.target) < 0.02) g.animating = false;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={!reduced}
      dampingFactor={0.12}
      minPolarAngle={POLAR_MIN}
      maxPolarAngle={POLAR_MAX}
      onStart={() => {
        goal.current.userMoved = true;
        goal.current.animating = false;
      }}
      onChange={() => {
        const c = controls.current;
        if (!c) return;
        const b = bounds.current;
        c.target.x = Math.min(b.maxX + 2, Math.max(b.minX - 2, c.target.x));
        c.target.z = Math.min(b.maxZ + 2, Math.max(b.minZ - 2, c.target.z));
      }}
    />
  );
}

/** Frame rate, draw calls and triangles, shown in demo mode and exposed for the browser tests. */
function Stats({ out }: { out: MutableRefObject<HTMLPreElement | null> }) {
  const gl = useThree((s) => s.gl);
  const last = useRef({ at: performance.now(), frames: 0, cpu: 0 });
  useEffect(() => {
    // Time the CPU side of drawing: with the frame rate capped by the screen, this shows the headroom.
    const original = gl.render.bind(gl);
    gl.render = (...args: Parameters<typeof gl.render>) => {
      const t0 = performance.now();
      original(...args);
      last.current.cpu += performance.now() - t0;
    };
    return () => {
      gl.render = original;
    };
  }, [gl]);
  useFrame(() => {
    const l = last.current;
    l.frames++;
    const now = performance.now();
    if (now - l.at < 500) return;
    const info = gl.info.render;
    const stats = { fps: +((l.frames * 1000) / (now - l.at)).toFixed(1), cpuMs: +(l.cpu / l.frames).toFixed(2), calls: info.calls, triangles: info.triangles };
    (window as unknown as { __office?: unknown }).__office = stats;
    if (out.current) out.current.textContent = `${stats.fps} fps · ${stats.cpuMs} ms/frame · ${stats.calls} draws · ${stats.triangles} tris`;
    l.at = now;
    l.frames = 0;
    l.cpu = 0;
  });
  return null;
}

const shortText = (text: string | null, max: number) => {
  const chars = Array.from((text ?? "").replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("") + "…";
};

/** The role under the name, and, when the tag is hovered or selected, who the agent reports to and its current task. */
function TagCard({ agent, role }: { agent: Agent; role: ReturnType<typeof roleOf> }) {
  const task = shortText(agent.currentTask, 90);
  return (
    <>
      {role && <span className="tag-role">{shortText(role.person.role, 24)}</span>}
      <span className="tag-detail">
        <span>{role ? role.reportsTo : "No role set"}</span>
        <span>{task ? `Task: ${task}` : "No task"}</span>
      </span>
    </>
  );
}

export type OfficeCanvasProps = {
  agents: readonly Agent[];
  /** The team, for the role and the manager shown on a name tag. */
  team?: readonly Person[];
  connection: "connecting" | "connected" | "disconnected";
  demo: boolean;
  layout: Layout;
  /** Findings waiting for a decision, shown on the hub's sign. */
  selection: Selection;
  /** Raised by one each time the header's Reset view is pressed. */
  resetSignal: number;
  onTryDemo: () => void;
  onStartWorker: () => void;
};

export function OfficeCanvas({ agents, team = [], connection, demo, layout, selection, resetSignal, onTryDemo, onStartWorker }: OfficeCanvasProps) {
  const scheme = useScheme();
  const reduced = useReducedMotion();
  const [supported] = useState(webglAvailable);
  const [lost, setLost] = useState(false);
  const [generation, setGeneration] = useState(0);
  const rig = useRef<RigApi | null>(null);
  const tagRefs = useRef(new Map<string, HTMLElement>());
  const roomRefs = useRef(new Map<string, HTMLElement>());
  const bubbleRefs = useRef<(HTMLElement | null)[]>([]);
  const { room } = useSelection(selection);
  const stats = useRef<HTMLPreElement | null>(null);

  const frozen = connection === "disconnected" && !demo;
  const assignment = layout.placement;
  const shown = agents.filter((a) => assignment.seat.has(a.id));
  const hidden = assignment.unseated;
  const limit = useMemo(() => overviewBounds(), []);
  const focused = room === null ? undefined : layout.building.rooms.find((r) => r.key === room);
  const view = useMemo(() => (focused === undefined ? limit : roomBounds(focused)), [focused, limit]);
  // A room that has gone (a department taken off the team) cannot keep the focus.
  useEffect(() => {
    if (room !== null && focused === undefined) selection.focusRoom(null);
  }, [room, focused, selection]);
  const families = familyIndexes(agents);
  const looks = useMemo(() => new Map(agents.map((a) => [a.id, lookOfAgent(a, team)])), [agents, team]);
  const empty = agents.length === 0 && connection === "connected" && !demo;

  useEffect(() => {
    if (resetSignal > 0) rig.current?.reset();
  }, [resetSignal]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const api = rig.current;
    if (!api) return;
    const handled = { ArrowLeft: () => api.orbit(-0.1, 0), ArrowRight: () => api.orbit(0.1, 0), ArrowUp: () => api.orbit(0, 0.08), ArrowDown: () => api.orbit(0, -0.08), "+": () => api.zoom(0.9), "=": () => api.zoom(0.9), "-": () => api.zoom(1.1), "0": () => api.reset() }[e.key];
    if (!handled) return;
    e.preventDefault();
    handled();
  };

  return (
    <section className={`office${frozen ? " office-frozen" : ""}`} aria-label="Office view">
      <div
        className="office-stage"
        tabIndex={0}
        role="group"
        aria-label="Office view. Arrow keys turn the view, plus and minus zoom, 0 resets."
        onKeyDown={onKey}
      >
        {supported && !lost ? (
          <Canvas
            key={generation}
            flat
            dpr={[1, 1.5]}
            frameloop={reduced ? "demand" : "always"}
            camera={{ fov: CAMERA_FOV_DEG, near: 0.5, far: 400, position: [0, 20, 30] }}
            gl={{ antialias: true }}
            onPointerMissed={() => selection.select(null)}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener("webglcontextlost", (e) => {
                e.preventDefault();
                setLost(true);
              });
            }}
          >
            <Office agents={agents} scheme={scheme} reduced={reduced} frozen={frozen} selection={selection} tagRefs={tagRefs} layout={layout} looks={looks} roomRefs={roomRefs} bubbleRefs={bubbleRefs} />
            <CameraRig view={view} limit={limit} focusKey={room ?? ""} reduced={reduced} api={rig} />
            {demo && <Stats out={stats} />}
          </Canvas>
        ) : (
          <div className="office-notice" role="status">
            <p>3D view unavailable; the list shows everything.</p>
            {lost && (
              <button
                type="button"
                onClick={() => {
                  setLost(false);
                  setGeneration((g) => g + 1);
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}

        <div className="office-rooms">
          {layout.building.rooms.filter((r) => r.desks.length > 0).map(({ key, name }) => {
            const members = agents.filter((a) => assignment.roomOf.get(a.id) === key);
            const errors = members.filter((a) => a.status === "error").length;
            return (
              <button
                key={key}
                type="button"
                className={`room-sign${room === key ? " room-focused" : ""}${errors > 0 ? " room-error" : ""}`}
                style={{ display: "none" }}
                aria-pressed={room === key}
                ref={(el) => {
                  if (el) roomRefs.current.set(key, el);
                  else roomRefs.current.delete(key);
                }}
                onClick={() => selection.focusRoom(room === key ? null : key)}
              >
                <span className="room-name">{name}</span>
                <span className="room-meta">
                  {members.length} {members.length === 1 ? "agent" : "agents"}
                  {errors > 0 ? ` · ${errors} error` : ""}
                </span>
              </button>
            );
          })}
          {layout.building.rooms.filter((r) => r.desks.length === 0).map(({ key, name }) => (
            // The shared rooms hold no desks, so there is nothing to focus: a name on the floor, for the eye only.
            <span
              key={key}
              className="room-sign room-label"
              style={{ display: "none" }}
              aria-hidden="true"
              ref={(el) => {
                if (el) roomRefs.current.set(key, el);
                else roomRefs.current.delete(key);
              }}
            >
              <span className="room-name">{name}</span>
            </span>
          ))}
        </div>

        <div className="office-bubbles" aria-hidden="true">
          {Array.from({ length: MAX_BUBBLES }, (_, i) => (
            <div
              key={i}
              className="office-bubble"
              style={{ display: "none" }}
              ref={(el) => {
                bubbleRefs.current[i] = el;
              }}
            />
          ))}
        </div>

        <div className="office-tags" aria-hidden="true">
          {shown.map((a) => {
            const role = roleOf(a, team);
            return (
            <div
              key={a.id}
              className="office-tag"
              style={{ display: "none" }}
              ref={(el) => {
                if (el) tagRefs.current.set(a.id, el);
                else tagRefs.current.delete(a.id);
              }}
            >
              <span className="tag-line">
                {role && <AvatarImage avatar={avatarOf(role.person)} size={20} />}
                <span className="tag-family">{FAMILY_LETTERS[families.get(a.id) ?? 0]}</span>
                <span className="tag-name">{truncateTag(a.name)}</span>
                <span className="tag-status">{a.status}</span>
              </span>
              <TagCard agent={a} role={role} />
            </div>
            );
          })}
        </div>

        {demo && <div className="office-watermark" aria-hidden="true">DEMO</div>}
        {demo && supported && !lost && <pre className="office-stats" ref={stats} aria-hidden="true" />}
        {connection === "connecting" && agents.length === 0 && !demo && <p className="office-overlay" role="status">Connecting…</p>}
        {frozen && <p className="office-banner" role="status">Showing last known state</p>}
        {hidden > 0 && <p className="office-chip">+{hidden} more in the list</p>}
        {empty && (
          <div className="office-empty">
            <h2>No sessions yet</h2>
            <p>A session appears here when it starts working.</p>
            <div className="office-empty-actions">
              <button type="button" onClick={onStartWorker}>
                Start a worker
              </button>
              <button type="button" onClick={onTryDemo}>
                Try demo
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
