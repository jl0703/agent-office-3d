// The last few folders and prompts the owner started something with. Kept in this browser only.

export const RECENT_MAX = 5;
const KEY = "office.recent-starts";

export type Recent = { folders: string[]; prompts: string[] };
type Store = Pick<Storage, "getItem" | "setItem">;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, RECENT_MAX) : []);

export function loadRecent(store: Store | null = safeStore()): Recent {
  try {
    const data: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    const o = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    return { folders: strings(o["folders"]), prompts: strings(o["prompts"]) };
  } catch {
    return { folders: [], prompts: [] };
  }
}

const push = (list: string[], item: string) => (item ? [item, ...list.filter((x) => x !== item)].slice(0, RECENT_MAX) : list);

/** Puts a started folder (may be empty for research) and prompt first; returns the new lists. */
export function remember(folder: string, prompt: string, store: Store | null = safeStore()): Recent {
  const before = loadRecent(store);
  const next = { folders: push(before.folders, folder.trim()), prompts: push(before.prompts, prompt.trim()) };
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: the lists still work for this visit
  }
  return next;
}

function safeStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
