import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { VaultInfo } from "../../shared/vault.ts";

export const MAX_NOTES = 5000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_NODES = 200;
export const MAX_LINKS = 1000;
export const MAX_TARGETS_PER_NOTE = 500;
export const MAX_DIRS = 5000;
const RECENT = 5;
const BATCH = 64;
const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

type Note = { path: string; title: string; mtime: number; targets: string[] };

export type Vault = { get(refresh: boolean): Promise<VaultInfo> };

/**
 * Read-only view of an Obsidian vault. Caches the scan for `ttlMs`; a forced refresh is
 * honoured at most once per `minRefreshMs`. With no usable folder it answers `connected: false`.
 */
export function createVault(
  dir: string | undefined,
  opts: { ttlMs?: number; minRefreshMs?: number; now?: () => number } = {},
): Vault {
  const { ttlMs = 30_000, minRefreshMs = 5000, now = Date.now } = opts;
  let cached: { at: number; info: VaultInfo } | undefined;
  let inflight: Promise<VaultInfo> | undefined;

  const rescan = () => {
    inflight ??= scan(dir)
      .then((info) => {
        cached = { at: now(), info };
        return info;
      })
      .finally(() => (inflight = undefined));
    return inflight;
  };

  return {
    async get(refresh) {
      if (!dir) return { connected: false };
      if (cached) {
        const age = now() - cached.at;
        if (age < ttlMs && !(refresh && age >= minRefreshMs)) return cached.info;
      }
      return rescan();
    },
  };
}

async function scan(dir: string | undefined): Promise<VaultInfo> {
  if (!dir || dir.includes("\0") || !isAbsolute(dir)) return { connected: false };
  let root: string;
  try {
    root = await realpath(dir);
    if (!(await stat(root)).isDirectory()) return { connected: false };
  } catch {
    return { connected: false };
  }

  const notes = await collect(root);
  const byKey = new Map<string, string>(); // lower-case title or path (without .md) -> note path
  for (const n of notes) {
    for (const key of [n.title, n.path.slice(0, -3)]) {
      const k = key.toLowerCase();
      if (!byKey.has(k)) byKey.set(k, n.path);
    }
  }

  const edges = new Set<string>();
  const degree = new Map<string, number>();
  for (const n of notes) {
    for (const t of n.targets) {
      const to = byKey.get(t.toLowerCase());
      if (!to || to === n.path || edges.has(`${n.path}\0${to}`)) continue;
      edges.add(`${n.path}\0${to}`);
      degree.set(n.path, (degree.get(n.path) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
  }

  const byRecency = [...notes].sort((a, b) => b.mtime - a.mtime);
  const chosen = [...notes]
    .sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || b.mtime - a.mtime)
    .slice(0, MAX_NODES);
  const ids = new Set(chosen.map((n) => n.path));
  const links: { from: string; to: string }[] = [];
  for (const e of edges) {
    const [from = "", to = ""] = e.split("\0");
    if (ids.has(from) && ids.has(to) && links.length < MAX_LINKS) links.push({ from, to });
  }

  return {
    connected: true,
    name: basename(root),
    noteCount: notes.length,
    recent: byRecency.slice(0, RECENT).map(({ title, path, mtime }) => ({ title, path, mtime })),
    nodes: chosen.map((n) => ({ id: n.path, title: n.title })),
    links,
  };
}

/** Walks the vault breadth-first and reads notes in batches, so the event loop keeps turning. */
async function collect(root: string): Promise<Note[]> {
  const notes: Note[] = [];
  const seenDirs = new Set<string>([root]);
  const queue: string[] = [root];
  while (queue.length > 0 && notes.length < MAX_NOTES) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .obsidian, .trash, .git and any other hidden entry
      const full = join(dir, e.name);
      let real = full;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          real = await realpath(full);
          const s = await stat(real);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          continue;
        }
        if (!isInside(root, real) || relative(root, real).split(sep).some((p) => p.startsWith("."))) continue;
      }
      if (isDir) {
        if (!seenDirs.has(real) && seenDirs.size < MAX_DIRS) {
          seenDirs.add(real);
          queue.push(real);
        }
      } else if (isFile && e.name.toLowerCase().endsWith(".md")) {
        files.push(real);
      }
    }
    for (let i = 0; i < files.length && notes.length < MAX_NOTES; i += BATCH) {
      const room = MAX_NOTES - notes.length;
      const batch = await Promise.all(files.slice(i, i + Math.min(BATCH, room)).map((f) => readNote(root, f)));
      for (const n of batch) if (n) notes.push(n);
    }
  }
  return notes;
}

async function readNote(root: string, file: string): Promise<Note | undefined> {
  try {
    const s = await stat(file);
    const path = relative(root, file).split(sep).join("/");
    const targets = s.size <= MAX_FILE_BYTES ? linkTargets(await readFile(file, "utf8")) : [];
    return { path, title: basename(file).slice(0, -3), mtime: s.mtimeMs, targets };
  } catch {
    return undefined;
  }
}

/** `[[Note]]`, `[[Note|alias]]` and `[[Note#heading]]` all point at "Note". */
function linkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK)) {
    const target = (m[1] ?? "").split("|")[0]?.split("#")[0]?.trim().replace(/\.md$/i, "");
    if (target) out.push(target);
    if (out.length >= MAX_TARGETS_PER_NOTE) break;
  }
  return out;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
