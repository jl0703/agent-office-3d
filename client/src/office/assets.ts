import { type BufferGeometry, DoubleSide, LineBasicMaterial, MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { AgentStatus } from "../../../shared/events.ts";
import {
  accessoryGeometry,
  armGeometry,
  beaconGeometry,
  chairGeometry,
  deskGeometry,
  flatPlane,
  flatRing,
  headGeometry,
  legsGeometry,
  monitorGeometry,
  pennantGeometry,
  screenGeometry,
  torsoGeometry,
  unitBox,
} from "./geometry.ts";
import { ACCESSORIES, SCENE, STATUS_COLOR, STATUSES, type Accessory, type Scheme } from "./palette.ts";
import { makeScreenTextures, makeShadowTexture } from "./textures.ts";

type Visible = Exclude<Accessory, "none">;

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
    head: headGeometry(scheme),
    accessories: Object.fromEntries(ACCESSORIES.filter((a): a is Visible => a !== "none").map((a) => [a, accessoryGeometry(a)])) as Record<Visible, BufferGeometry>,
    pennants: Object.fromEntries(STATUSES.map((s) => [s, pennantGeometry(s)])) as Record<AgentStatus, BufferGeometry>,
    ring: flatRing(0.92, 1.0),
    ringSoft: flatRing(0.9, 1.0),
    shadow: flatPlane(1, 1),
    stripe: flatPlane(1.2, 0.34),
    beacon: beaconGeometry(),
    box: unitBox(),
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
