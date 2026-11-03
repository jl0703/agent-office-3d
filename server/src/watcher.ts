import { watch, type FSWatcher, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Registry } from "./registry.ts";
import { clean, parseLine, type ParsedLine } from "./transcript.ts";

// Read-only: files are only ever opened for reading, and nothing is created or changed
// under the log folder. Only <config dir>/projects is read, never its siblings (the
// "sessions" folder next to it holds credentials).

export type WatcherOptions = {
  root: string;
  registry: Registry;
  /** A session with no writes for this long leaves the list. */
  staleMs?: number;
  /** How often the backup sweep runs. */
  sweepMs?: number;
  /** Set false to rely on the sweep alone. */
  watch?: boolean;
  maxAgents?: number;
  maxLineBytes?: number;
  /** How much of the end of a big file is read when a session is first seen. */
  tailBytes?: number;
  log?: (line: Record<string, unknown>) => void;
};

export type Watcher = {
  /** Runs one full sweep and resolves when it is done. */
  scan(): Promise<void>;
  close(): Promise<void>;
};

type Parsed = Extract<ParsedLine, { ok: true }>;
type Candidate = {
  kind: "session" | "subagent";
  id: string;
  path: string;
  parentId: string | null;
  metaPath: string | null;
};
type FileState = Candidate & { offset: number; carry: Buffer; skipping: boolean; metaStamp: string };
type Meta = { agentType: string | null; description: string | null; finished: boolean };

const ID = "[A-Za-z0-9_-]{1,100}";
const SESSION_FILE = new RegExp(`^(${ID})\\.jsonl$`);
const SUBAGENT_FILE = new RegExp(`^(agent-[A-Za-z0-9_-]{1,100})\\.jsonl$`);
const SESSION_EVENT = new RegExp(`^([^/]+)/(${ID})\\.jsonl$`);
const SUBAGENT_EVENT = new RegExp(`^([^/]+)/(${ID})/subagents/(agent-[A-Za-z0-9_-]{1,100})\\.(?:jsonl|meta\\.json)$`);
const ID_ONLY = new RegExp(`^${ID}$`);
const CHUNK = 256 * 1024;
const META_MAX = 64 * 1024;
const MAX_WARNINGS = 1000;
const EMPTY = Buffer.alloc(0);

export function projectsRoot(env: Record<string, string | undefined>, home: string): string {
  return join(env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), "projects");
}

export async function startWatcher(opts: WatcherOptions): Promise<Watcher> {
  const { root, registry } = opts;
  const staleMs = opts.staleMs ?? 15 * 60_000;
  const sweepMs = opts.sweepMs ?? 5_000;
  const maxAgents = opts.maxAgents ?? 200;
  const maxLine = opts.maxLineBytes ?? 1_000_000;
  const tailBytes = opts.tailBytes ?? 1_000_000;
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));

  const files = new Map<string, FileState>();
  const warned = new Set<string>();
  let fsWatcher: FSWatcher | null = null;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let sweepWaiting = false;

  // One job at a time, so a file event and a sweep never read the same file together.
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    queue = queue.then(job).catch((err: unknown) => {
      log({ event: "watcher-error", message: err instanceof Error ? err.message : String(err) });
    });
    return queue;
  };

  const warnOnce = (key: string, detail: Record<string, unknown> = {}) => {
    if (warned.has(key)) return;
    if (warned.size >= MAX_WARNINGS) warned.clear();
    warned.add(key);
    log({ event: "warn", key, ...detail });
  };

  const drop = (state: FileState) => {
    registry.remove(state.id);
    files.delete(state.path);
  };

  async function discover(): Promise<Candidate[]> {
    const found: Candidate[] = [];
    for (const project of await readdirSafe(root)) {
      if (!project.isDirectory()) continue; // a symbolic link reports false here
      const projectDir = join(root, project.name);
      for (const entry of await readdirSafe(projectDir)) {
        if (entry.isFile()) {
          const id = SESSION_FILE.exec(entry.name)?.[1];
          if (id) found.push({ kind: "session", id, path: join(projectDir, entry.name), parentId: null, metaPath: null });
        } else if (entry.isDirectory() && ID_ONLY.test(entry.name)) {
          const subDir = join(projectDir, entry.name, "subagents");
          if (!(await lstatSafe(subDir))?.isDirectory()) continue; // a link is not followed
          for (const sub of await readdirSafe(subDir)) {
            const id = sub.isFile() ? SUBAGENT_FILE.exec(sub.name)?.[1] : undefined;
            if (id) found.push(subagent(subDir, id, entry.name));
          }
        }
      }
    }
    return found;
  }

  const subagent = (subDir: string, id: string, parentId: string): Candidate => ({
    kind: "subagent",
    id,
    path: join(subDir, `${id}.jsonl`),
    parentId,
    metaPath: join(subDir, `${id}.meta.json`),
  });

  async function syncFile(c: Candidate, nowMs: number) {
    const st = await lstatSafe(c.path);
    const state = files.get(c.path);
    if (!st?.isFile() || nowMs - st.mtimeMs > staleMs) {
      if (state) drop(state);
      return;
    }
    if (state) {
      await readNew(state, (p) => registry.apply(state.id, p.facts, p.ts));
      await syncMeta(state);
      return;
    }
    if (registry.size() >= maxAgents) return warnOnce("cap", { max: maxAgents });
    await adopt(c, st);
  }

  async function adopt(c: Candidate, st: Stats) {
    const offset = Math.max(0, st.size - tailBytes);
    const state: FileState = { ...c, offset, carry: EMPTY, skipping: offset > 0, metaStamp: "" };
    const seen: Parsed[] = [];
    await readNew(state, (p) => seen.push(p));
    // The working folder names the project. Until a line shows it, wait.
    const cwd = seen.find((p) => p.cwd !== null)?.cwd;
    if (!cwd) return;

    const meta = c.metaPath ? await readMeta(c.metaPath) : null;
    const project = clean(baseName(cwd)) || "unknown";
    registry.upsert(c.id, {
      kind: c.kind,
      parentId: c.parentId,
      project,
      name: meta?.agentType ?? project,
      currentTask: meta?.description ?? null,
    });
    for (const p of seen) registry.apply(c.id, p.facts, p.ts);
    files.set(c.path, state);
    await syncMeta(state);
  }

  async function readNew(state: FileState, sink: (p: Parsed) => void) {
    let fh: FileHandle;
    try {
      fh = await open(state.path, "r");
    } catch {
      return drop(state);
    }
    try {
      const size = (await fh.stat()).size;
      if (size < state.offset) {
        // The file was replaced by a shorter one: start over.
        state.offset = 0;
        state.carry = EMPTY;
        state.skipping = false;
        registry.clearPending(state.id);
      }
      const buf = Buffer.allocUnsafe(CHUNK);
      while (state.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - state.offset), state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        feed(state, buf.subarray(0, bytesRead), sink);
      }
    } finally {
      await fh.close();
    }
  }

  // Splits bytes into lines. A last line without a newline waits in `carry`; a line
  // that is too long is thrown away up to its newline, without ever being held in full.
  function feed(state: FileState, buf: Buffer, sink: (p: Parsed) => void) {
    let start = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
      const piece = buf.subarray(start, i);
      start = i + 1;
      if (state.skipping) {
        state.skipping = false;
        state.carry = EMPTY;
        continue;
      }
      const whole = state.carry.length ? Buffer.concat([state.carry, piece]) : piece;
      state.carry = EMPTY;
      handleLine(state, whole, sink);
    }
    const rest = buf.subarray(start);
    if (state.skipping || rest.length === 0) return;
    if (state.carry.length + rest.length > maxLine) {
      warnOnce(`oversize:${state.id}`, { id: state.id, limit: maxLine });
      state.skipping = true;
      state.carry = EMPTY;
      return;
    }
    state.carry = Buffer.concat([state.carry, rest]);
  }

  function handleLine(state: FileState, line: Buffer, sink: (p: Parsed) => void) {
    if (line.length === 0) return;
    if (line.length > maxLine) return warnOnce(`oversize:${state.id}`, { id: state.id, limit: maxLine });
    const parsed = parseLine(line.toString("utf8"));
    if (!parsed.ok) return warnOnce(`malformed:${state.id}`, { id: state.id });
    if (parsed.unknownType) warnOnce(`type:${parsed.unknownType}`, { type: parsed.unknownType });
    sink(parsed);
  }

  async function syncMeta(state: FileState) {
    if (!state.metaPath) return;
    const st = await lstatSafe(state.metaPath);
    if (!st?.isFile() || st.size > META_MAX) return;
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === state.metaStamp) return;
    const meta = await readMeta(state.metaPath);
    state.metaStamp = stamp;
    if (meta) registry.setFinished(state.id, meta.finished);
  }

  async function sweep() {
    const nowMs = Date.now();
    const seen = new Set<string>();
    for (const c of await discover()) {
      seen.add(c.path);
      await syncFile(c, nowMs);
    }
    for (const state of files.values()) if (!seen.has(state.path)) drop(state);
    registry.refreshStatuses();
  }

  // A single changed file: cheaper than a full sweep.
  async function onEvent(rel: string) {
    const path = rel.replaceAll("\\", "/");
    let candidate: Candidate | null = null;
    let dirs: string[] = [];
    const s = SESSION_EVENT.exec(path);
    const a = SUBAGENT_EVENT.exec(path);
    if (s?.[1] && s[2]) {
      candidate = { kind: "session", id: s[2], path: join(root, s[1], `${s[2]}.jsonl`), parentId: null, metaPath: null };
      dirs = [join(root, s[1])];
    } else if (a?.[1] && a[2] && a[3]) {
      candidate = subagent(join(root, a[1], a[2], "subagents"), a[3], a[2]);
      dirs = [join(root, a[1]), join(root, a[1], a[2]), join(root, a[1], a[2], "subagents")];
    }
    if (!candidate) return;
    for (const dir of dirs) if (!(await lstatSafe(dir))?.isDirectory()) return; // not a real folder
    await syncFile(candidate, Date.now());
  }

  function tryWatch() {
    if (fsWatcher || closed || opts.watch === false) return;
    try {
      fsWatcher = watch(root, { recursive: true }, (_event, filename) => {
        if (typeof filename === "string") void enqueue(() => onEvent(filename));
      });
      fsWatcher.on("error", (err) => {
        log({ event: "watch-error", message: err.message });
        fsWatcher?.close();
        fsWatcher = null;
      });
    } catch {
      fsWatcher = null; // the folder may not exist yet; the sweep tries again
    }
  }

  const requestSweep = () => {
    if (sweepWaiting) return;
    sweepWaiting = true;
    void enqueue(async () => {
      sweepWaiting = false;
      await sweep();
    });
  };

  tryWatch();
  await enqueue(sweep);
  const timer = setInterval(() => {
    tryWatch();
    requestSweep();
  }, sweepMs);
  timer.unref();

  return {
    scan: () => enqueue(sweep),
    async close() {
      closed = true;
      clearInterval(timer);
      fsWatcher?.close();
      fsWatcher = null;
      await queue;
    },
  };
}

async function readMeta(path: string): Promise<Meta | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(META_MAX);
    const { bytesRead } = await fh.read(buf, 0, META_MAX, 0);
    const value: unknown = JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    return {
      agentType: typeof v["agentType"] === "string" && clean(v["agentType"]) ? clean(v["agentType"]) : null,
      description: typeof v["description"] === "string" && clean(v["description"]) ? clean(v["description"]) : null,
      finished: v["finished"] === true,
    };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

const lstatSafe = (path: string) => lstat(path).catch(() => null);
const readdirSafe = (path: string) => readdir(path, { withFileTypes: true }).catch(() => []);

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}
