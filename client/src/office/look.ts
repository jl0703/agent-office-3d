// How a character in the office looks: from the person's drawn avatar, or from the agent's id when it works for no person.
import { HAIR_COLOR, OUTFIT_COLOR, SKIN, defaultAvatar, type Avatar } from "../avatar.ts";
import { avatarOf, type Person } from "../team.ts";
import { CHARACTER_COLORS, characterStyle, type Accessory } from "./palette.ts";

/** What the office draws on one character: colours as hex, styles as the avatar's own numbers. */
export type Look = { skin: string; hair: number; hairColor: string; outfit: number; outfitColor: string; accessory: Accessory };

/** The avatar's four glasses choices: none, round, square, sunglasses. */
const GLASSES: readonly Accessory[] = ["none", "glasses", "glasses", "sunglasses"];

/** The colours and styles of an avatar. Eyes, mouth and background stay on the picture: too small to read from the office distance. */
export function lookOfAvatar(avatar: Avatar): Look {
  return {
    skin: SKIN[avatar.skin] as string,
    hair: avatar.hair,
    hairColor: HAIR_COLOR[avatar.hairColor] as string,
    outfit: avatar.outfit,
    outfitColor: OUTFIT_COLOR[avatar.outfitColor] as string,
    accessory: GLASSES[avatar.glasses] ?? "none",
  };
}

/**
 * A person's agent looks like the person's picture. Any other agent keeps its own colour and accessory (colour says who it is) and gets
 * skin, hair and outfit style from its id, so that it is not the same as the next one.
 */
export function lookOfAgent(agent: { id: string; personId?: string }, team: readonly Person[]): Look {
  const person = agent.personId ? team.find((p) => p.id === agent.personId) : undefined;
  if (person) return lookOfAvatar(avatarOf(person));
  const style = characterStyle(agent.id);
  return { ...lookOfAvatar(defaultAvatar(agent.id)), outfitColor: CHARACTER_COLORS[style.color] as string, accessory: style.accessory };
}
