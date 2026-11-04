import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, sep } from "node:path";

export type FolderCheck =
  | { ok: true; path: string }
  | { ok: false; reason: "not_absolute" | "not_found" | "not_directory" | "outside_roots" };

/** Allowed folders from a setting such as "C:\a;C:\b". Falls back to one folder when empty. */
export function parseRoots(value: string | undefined, fallback: string): string[] {
  const roots = (value ?? "").split(delimiter).map((part) => part.trim()).filter(Boolean);
  return roots.length > 0 ? roots : [fallback];
}

/**
 * Resolves a requested folder to its real path (following links) and checks that it is a
 * directory inside one of the allowed roots. The check uses real paths on both sides, so
 * ".." and links cannot be used to step outside a root.
 */
export async function resolveAllowedFolder(requested: string, roots: string[]): Promise<FolderCheck> {
  if (requested.includes("\0") || !isAbsolute(requested)) return { ok: false, reason: "not_absolute" };
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!(await stat(real)).isDirectory()) return { ok: false, reason: "not_directory" };

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue; // a root that does not exist allows nothing
    }
    if (isInside(realRoot, real)) return { ok: true, path: real };
  }
  return { ok: false, reason: "outside_roots" };
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
