import { type BufferGeometry, DoubleSide, LineBasicMaterial, MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { AgentStatus } from "../../../shared/events.ts";
import {
  accessoryGeometry,
  armGeometry,
  beaconGeometry,
  benchGeometry,
  bushGeometry,
  treeGeometry,
  chairGeometry,
  lampGeometry,
  plantGeometry,
  deskGeometry,
  flatPlane,
  flatRing,
  hairGeometry,
  headGeometry,
  legsGeometry,
  outfitGeometry,
  monitorGeometry,
  pennantGeometry,
  screenGeometry,
  torsoGeometry,
  walkLegGeometry,
  unitBox,
} from "./geometry.ts";
import { AVATAR_PARTS } from "../../../shared/avatar.ts";
import { ALL_ACCESSORIES, SCENE, STATUS_COLOR, STATUSES, type Scheme } from "./palette.ts";
import { makeScreenTextures, makeShadowTexture } from "./textures.ts";

type Visible = (typeof ALL_ACCESSORIES)[number];

/** Every shape, material, and texture the office uses. Built once per colour scheme and disposed when replaced. */
export function createAssets(scheme: Scheme) {
  const c = SCENE[scheme];
  const lambert = (opts: ConstructorParameters<typeof MeshLambertMaterial>[0]) => new MeshLambertMaterial({ flatShading: true, ...opts });

  const screenTextures = makeScreenTextures(scheme);
  const shadowTexture = makeShadowTexture();

  const geo = {
    desk: deskGeometry(scheme),
    chair: chairGeometry(scheme),
    monitor: monitorGeometry(),
    screen: screenGeometry(),
    legs: legsGeometry(),
    torso: torsoGeometry(),
    arm: armGeometry(),
    head: headGeometry(),
    accessories: Object.fromEntries(ALL_ACCESSORIES.map((a) => [a, accessoryGeometry(a)])) as Record<Visible, BufferGeometry>,
    hair: Array.from({ length: AVATAR_PARTS.hair }, (_, i) => hairGeometry(i)),
    outfit: Array.from({ length: AVATAR_PARTS.outfit }, (_, i) => outfitGeometry(i)),
    pennants: Object.fromEntries(STATUSES.map((s) => [s, pennantGeometry(s)])) as Record<AgentStatus, BufferGeometry>,
    ring: flatRing(0.92, 1.0),
    ringSoft: flatRing(0.9, 1.0),
    shadow: flatPlane(1, 1),
    stripe: flatPlane(1.2, 0.34),
    beacon: beaconGeometry(),
    box: unitBox(),
    walkLeg: walkLegGeometry(),
    plant: plantGeometry(),
    tree: treeGeometry(scheme),
    bush: bushGeometry(scheme),
    bench: benchGeometry(),
    lamp: lampGeometry(),
  };

  const mat = {
    vertex: lambert({ vertexColors: true }),
    person: lambert({}),
    floor: lambert({ color: c.floor }),
    lip: lambert({ color: c.lip }),
    screens: Object.fromEntries(STATUSES.map((s) => [s, new MeshBasicMaterial({ map: screenTextures[s], toneMapped: false })])) as Record<AgentStatus, MeshBasicMaterial>,
    pennants: Object.fromEntries(STATUSES.map((s) => [s, lambert({ vertexColors: true, color: STATUS_COLOR[scheme][s], side: DoubleSide })])) as Record<AgentStatus, MeshLambertMaterial>,
    stripe: new MeshBasicMaterial({ color: 0xffffff }),
    shadow: new MeshBasicMaterial({ map: shadowTexture, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
    selected: new MeshBasicMaterial({ color: c.selection, side: DoubleSide }),
    hover: new MeshBasicMaterial({ color: c.ink, side: DoubleSide, transparent: true, opacity: 0.7 }),
    pulse: new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide }),
    beacon: new MeshBasicMaterial({ color: STATUS_COLOR[scheme].error }),
    cable: new LineBasicMaterial({ color: c.ink, transparent: true, opacity: 0.35 }),
    cableHot: new LineBasicMaterial({ color: c.selection }),
    grid: new LineBasicMaterial({ color: c.grid }),
    outline: new LineBasicMaterial({ color: c.lip }),
    // Drawn into nothing, but still hit by the pointer, so characters can be clicked.
    room: lambert({}),
    glass: lambert({ color: scheme === "light" ? 0xbfd6e4 : 0x4a6178, transparent: true, opacity: 0.4, depthWrite: false }),
    ground: lambert({ color: scheme === "light" ? 0xc9bfa6 : 0x1d242d }),
    lawn: lambert({ color: scheme === "light" ? 0xa9cc8a : 0x27382d }),
    path: lambert({ color: scheme === "light" ? 0xe6dcc6 : 0x4a5362 }),
    board: new MeshBasicMaterial({ color: scheme === "light" ? 0xfbf8f0 : 0xdfe6ee }),
    hit: new MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  };

  // Frees the graphics memory of everything above, however deeply it is nested.
  const dispose = () => {
    const free = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const maybe = value as { dispose?: unknown };
      if (typeof maybe.dispose === "function") (maybe as { dispose(): void }).dispose();
      else Object.values(value).forEach(free);
    };
    [geo, mat, screenTextures, shadowTexture].forEach(free);
  };

  return { geo, mat, screenTextures, dispose };
}

export type Assets = ReturnType<typeof createAssets>;
