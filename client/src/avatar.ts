// The choices for a person's picture and how a look is made: from an id (the default) or at random (the Randomize button).
import { AVATAR_KEYS, AVATAR_PARTS, type Avatar, type AvatarPart } from "../../shared/avatar.ts";

export type { Avatar, AvatarPart };

export const SKIN = ["#f6d5bd", "#eab98f", "#d39a6c", "#b97a4d", "#8d5a38", "#5f3b24"];
export const HAIR_COLOR = ["#2b1d14", "#5a3a22", "#8a5a2b", "#c99a4b", "#d9d2c3", "#b3392b", "#2f6fa8", "#7a4aa5"];
export const OUTFIT_COLOR = ["#2f6fa8", "#3a8f6a", "#c4572b", "#7a4aa5", "#d1a12e", "#5b6b7a", "#b3392b", "#1f2a37"];
export const BACKGROUND = ["#dbe9f4", "#dff0e6", "#f6e3d6", "#e9def2", "#f7efd0", "#e4e8ec", "#f3d9dc", "#cfd8e3"];

export const HAIR_STYLE = ["Short", "Long", "Bun", "Curly", "Spiky", "Bald", "Side part", "Ponytail"];
export const EYES_STYLE = ["Round", "Happy", "Sleepy", "Wide"];
export const MOUTH_STYLE = ["Smile", "Grin", "Calm", "Open"];
export const GLASSES_STYLE = ["None", "Round", "Square", "Sunglasses"];
export const OUTFIT_STYLE = ["T-shirt", "Shirt", "Hoodie", "Suit", "Turtleneck"];

/** The words for each choice of each part, used by the designer's buttons. Colours are named by their number. */
export const LABELS: Record<AvatarPart, string[]> = {
  skin: SKIN.map((_, i) => `Skin tone ${i + 1}`),
  hair: HAIR_STYLE,
  hairColor: HAIR_COLOR.map((_, i) => `Hair colour ${i + 1}`),
  eyes: EYES_STYLE,
  mouth: MOUTH_STYLE,
  glasses: GLASSES_STYLE,
  outfit: OUTFIT_STYLE,
  outfitColor: OUTFIT_COLOR.map((_, i) => `Outfit colour ${i + 1}`),
  background: BACKGROUND.map((_, i) => `Background ${i + 1}`),
};

export const PART_TITLE: Record<AvatarPart, string> = { skin: "Skin", hair: "Hair style", hairColor: "Hair colour", eyes: "Eyes", mouth: "Mouth", glasses: "Glasses", outfit: "Outfit", outfitColor: "Outfit colour", background: "Background" };

/** A small, fast random source with a fixed start, so one id always gives the same numbers. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A look made from a random source: every part inside its list. */
export function randomAvatar(rng: () => number = Math.random): Avatar {
  const pick = (k: AvatarPart) => Math.min(AVATAR_PARTS[k] - 1, Math.floor(rng() * AVATAR_PARTS[k]));
  return Object.fromEntries(AVATAR_KEYS.map((k) => [k, pick(k)])) as Avatar;
}

/** The look a person has until the owner changes it: always the same for the same id. */
export const defaultAvatar = (id: string): Avatar => randomAvatar(seeded(hash(id)));

export const sameAvatar = (a: Avatar, b: Avatar) => AVATAR_KEYS.every((k) => a[k] === b[k]);
