import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState, type ElementRef, type KeyboardEvent, type MutableRefObject } from "react";
import { Spherical, Vector3 } from "three";
import type { Agent } from "../../../shared/events.ts";
import { Office } from "./Office.tsx";
import { CAMERA_AZIMUTH, CAMERA_ELEVATION, CAMERA_FOV_DEG, VISIBLE_DESKS, fitCamera, floorBounds, truncateTag } from "./layout.ts";
import { FAMILY_LETTERS } from "./palette.ts";
import { familyIndexes } from "./families.ts";
import { useReducedMotion, useScheme, webglAvailable } from "./hooks.ts";
import type { Selection } from "./selection.ts";

const rad = (deg: number) => (deg * Math.PI) / 180;
const POLAR_MIN = rad(25);
const POLAR_MAX = rad(70);
const AZIMUTH_MIN = CAMERA_AZIMUTH - rad(60);
const AZIMUTH_MAX = CAMERA_AZIMUTH + rad(60);

type RigApi = { reset(): void; orbit(dTheta: number, dPhi: number): void; zoom(factor: number): void };

/** Frames the occupied rows, keeps the user inside sensible limits, and eases between views. */
function CameraRig({ rows, reduced, api }: { rows: number; reduced: boolean; api: MutableRefObject<RigApi | null> }) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const aspect = size.width / Math.max(size.height, 1);
  const goal = useRef({ distance: 30, fit: 30, target: new Vector3(), animating: false, userMoved: false, placed: false });
  const bounds = useRef(floorBounds(rows));

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
    const fit = fitCamera(rows, aspect);
    const g = goal.current;
    g.fit = fit.distance;
    bounds.current = floorBounds(rows);
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
  }, [rows, aspect, reduced, place, invalidate]);

  useEffect(() => {
    const clampPolar = (v: number) => Math.min(POLAR_MAX, Math.max(POLAR_MIN, v));
    const move = (theta: number, phi: number, radius: number) => {
      const c = controls.current;
      if (!c) return;
      const g = goal.current;
      const spherical = new Spherical(Math.min(g.fit * 1.5, Math.max(g.fit * 0.5, radius)), clampPolar(phi), Math.min(AZIMUTH_MAX, Math.max(AZIMUTH_MIN, theta)));
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
        const fit = fitCamera(rows, aspect);
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
  }, [api, camera, rows, aspect, reduced, place, invalidate]);

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
      minAzimuthAngle={AZIMUTH_MIN}
      maxAzimuthAngle={AZIMUTH_MAX}
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

export type OfficeCanvasProps = {
  agents: readonly Agent[];
  connection: "connecting" | "connected" | "disconnected";
  demo: boolean;
  selection: Selection;
  onTryDemo: () => void;
  onExitDemo: () => void;
};

export function OfficeCanvas({ agents, connection, demo, selection, onTryDemo, onExitDemo }: OfficeCanvasProps) {
  const scheme = useScheme();
  const reduced = useReducedMotion();
  const [supported] = useState(webglAvailable);
  const [lost, setLost] = useState(false);
  const [rows, setRows] = useState(1);
  const [generation, setGeneration] = useState(0);
  const rig = useRef<RigApi | null>(null);
  const tagRefs = useRef(new Map<string, HTMLElement>());
  const stats = useRef<HTMLPreElement | null>(null);

  const frozen = connection === "disconnected" && !demo;
  const shown = agents.filter((a) => a.desk < VISIBLE_DESKS);
  const hidden = agents.length - shown.length;
  const families = familyIndexes(agents);
  const empty = agents.length === 0 && connection === "connected" && !demo;

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
            <Office agents={agents} scheme={scheme} reduced={reduced} frozen={frozen} selection={selection} tagRefs={tagRefs} onRows={setRows} />
            <CameraRig rows={rows} reduced={reduced} api={rig} />
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

        <div className="office-tags" aria-hidden="true">
          {shown.map((a) => (
            <div
              key={a.id}
              className="office-tag"
              style={{ display: "none" }}
              ref={(el) => {
                if (el) tagRefs.current.set(a.id, el);
                else tagRefs.current.delete(a.id);
              }}
            >
              <span className="tag-family">{FAMILY_LETTERS[families.get(a.id) ?? 0]}</span>
              <span className="tag-name">{truncateTag(a.name)}</span>
              <span className="tag-status">{a.status}</span>
            </div>
          ))}
        </div>

        {demo && <div className="office-watermark" aria-hidden="true">DEMO</div>}
        {demo && <pre className="office-stats" ref={stats} aria-hidden="true" />}
        {connection === "connecting" && agents.length === 0 && !demo && <p className="office-overlay" role="status">Connecting…</p>}
        {frozen && <p className="office-banner" role="status">Showing last known state</p>}
        {hidden > 0 && <p className="office-chip">+{hidden} more in the list</p>}
        {empty && (
          <div className="office-empty">
            <h2>No sessions yet</h2>
            <p>A session appears here when it starts working.</p>
            <div className="office-empty-actions">
              <button type="button" onClick={() => document.getElementById("start-form")?.scrollIntoView({ block: "center" })}>
                Start a worker
              </button>
              <button type="button" onClick={onTryDemo}>
                Try demo
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="office-toolbar">
        <button type="button" onClick={() => rig.current?.reset()}>
          Reset view
        </button>
        {demo ? (
          <button type="button" onClick={onExitDemo}>
            Exit demo
          </button>
        ) : (
          <button type="button" onClick={onTryDemo}>
            Try demo
          </button>
        )}
      </div>
    </section>
  );
}
