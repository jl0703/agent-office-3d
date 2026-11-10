// How a person's picture is described: a few small numbers, one per part, each an index into a fixed list of choices.
// The page draws from these and the server checks their ranges, so both read the counts from here.

export const AVATAR_PARTS = { skin: 6, hair: 8, hairColor: 8, eyes: 4, mouth: 4, glasses: 4, outfit: 5, outfitColor: 8, background: 8 } as const;

export type AvatarPart = keyof typeof AVATAR_PARTS;
export type Avatar = { [K in AvatarPart]: number };

export const AVATAR_KEYS = Object.keys(AVATAR_PARTS) as AvatarPart[];

/** True for an object with every part an integer inside its list, and nothing else. */
export function isAvatar(value: unknown): value is Avatar {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== AVATAR_KEYS.length) return false;
  return AVATAR_KEYS.every((k) => {
    const n = record[k];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < AVATAR_PARTS[k];
  });
}
