import type { AgentStatus } from "../../../shared/events.ts";

export type Scheme = "light" | "dark";

/** Colours of the paper-model scene. The page's own colours live in CSS. */
export const SCENE = {
  light: { canvas: "#F3EEE2", floor: "#D9D0BC", lip: "#B9AE96", grid: "#C4BAA3", desk: "#E6D9BC", deskDark: "#B89F78", ink: "#1F4E8C", selection: "#C2410C", skin: "#EADBC2", text: "#1B2430" },
  dark: { canvas: "#12161C", floor: "#2A323D", lip: "#1C222B", grid: "#3A4452", desk: "#566274", deskDark: "#3D4756", ink: "#7FB0F0", selection: "#FF9A5C", skin: "#CDBA9B", text: "#E8E4D8" },
} as const satisfies Record<Scheme, Record<string, string | number>>;

/** Status colours, each at least 4.5:1 on the page surface (checked in the workspace shell tests). */
export const STATUS_COLOR: Record<Scheme, Record<AgentStatus, string>> = {
  light: { working: "#0F6B4F", idle: "#5A6472", waiting: "#8A5A00", done: "#1F4E8C", stopped: "#6B4E3D", error: "#B3261E", detached: "#4B5563" },
  dark: { working: "#4ADE9E", idle: "#A9B1BC", waiting: "#F2B84B", done: "#7FB0F0", stopped: "#D2A98E", error: "#FF8A80", detached: "#9AA5B1" },
};

export const STATUSES: readonly AgentStatus[] = ["working", "idle", "waiting", "done", "stopped", "error", "detached"];

/** Eight muted hues for characters. Colour says who someone is, never what they are doing. */
export const CHARACTER_COLORS = ["#C8553D", "#2E86AB", "#7B9E3C", "#D9A21B", "#8E6BAE", "#2A9D8F", "#D17A9E", "#5C6BC0"] as const;

/** Six colours for families (a session and its subagents), with a letter so colour is not the only cue. */
export const FAMILY_COLORS = ["#1F4E8C", "#B3261E", "#0F6B4F", "#8A5A00", "#6B4E8F", "#00798C"] as const;
export const FAMILY_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export const ACCESSORIES = ["none", "glasses", "headphones", "cap", "antenna", "tie"] as const;
export type Accessory = (typeof ACCESSORIES)[number];

/** 32-bit FNV-1a: the same text always gives the same number. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function characterStyle(id: string): { color: number; accessory: Accessory } {
  const h = hashId(id);
  return { color: h % CHARACTER_COLORS.length, accessory: ACCESSORIES[(h >>> 3) % ACCESSORIES.length] ?? "none" };
}
