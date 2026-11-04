import type { AgentStatus } from "../../../shared/events.ts";

// Joint angles for a seated character, in radians. Arm angles turn about the shoulder:
// 0 hangs down, negative lifts forward and up. "Roll" swings an arm away from the body.
export type Pose = {
  lean: number; // torso, positive leans forward
  armL: number;
  armR: number;
  rollL: number;
  rollR: number;
  headYaw: number;
  headPitch: number; // positive looks down
  bob: number; // small vertical movement of the upper body
  chairBack: number; // how far the chair has rolled back
  breathe: number; // torso scale
};

export const REST_POSE: Pose = { lean: 0, armL: -0.5, armR: -0.5, rollL: 0, rollR: 0, headYaw: 0, headPitch: 0, bob: 0, chairBack: 0, breathe: 1 };

const TAU = Math.PI * 2;
const wave = (t: number, period: number) => Math.sin((TAU * t) / period);

/**
 * The pose for a status. `time` is the clock in seconds (for repeating movement) and `since` is how
 * long ago the status began (for one-off movements such as the stretch). With `reduced` set there
 * is no repeating movement and one-off movements are already finished.
 */
export function poseFor(status: AgentStatus, time: number, since: number, reduced: boolean): Pose {
  const w = reduced ? 0 : 1;
  const sinceEff = reduced ? Infinity : since;
  switch (status) {
    case "working": {
      const typing = 0.1 * w * wave(time, 0.3);
      return { ...REST_POSE, lean: 0.17, armL: -1.1 + typing, armR: -1.1 - typing, headPitch: 0.12, bob: 0.01 * w * wave(time, 0.6) };
    }
    case "idle":
      return { ...REST_POSE, headYaw: 0.26 * w * wave(time, 6), breathe: 1 + 0.01 * w * wave(time, 4) };
    case "waiting":
      return { ...REST_POSE, armL: 0.1, armR: -2.8, rollR: 0.17 * w * wave(time, 1) };
    case "done": {
      const stretching = sinceEff < 0.6;
      const arms = stretching ? -3.0 + 0.4 * (sinceEff / 0.6) : -2.6;
      return { ...REST_POSE, lean: -0.21, armL: arms, armR: arms, rollL: 0.6, rollR: 0.6 };
    }
    case "stopped":
      return { ...REST_POSE, lean: 0.05, armL: 0.1, armR: 0.1, headPitch: 0.35, chairBack: 0.3 };
    case "error": {
      const shaking = sinceEff < 1.5;
      return { ...REST_POSE, armL: -2.5, armR: -2.5, rollL: 0.5, rollR: 0.5, headYaw: shaking ? 0.07 * wave(sinceEff, 0.5) : 0 };
    }
    case "detached":
      return { ...REST_POSE, breathe: 1 + 0.01 * w * wave(time, 4) };
  }
}

/** Moves a pose toward a target without a jump. About 400 ms to settle, whatever the frame rate. */
export function blendPose(current: Pose, target: Pose, dt: number): Pose {
  const k = 1 - Math.exp(-8 * dt);
  const out = { ...current };
  for (const key of Object.keys(current) as (keyof Pose)[]) out[key] = current[key] + (target[key] - current[key]) * k;
  return out;
}
