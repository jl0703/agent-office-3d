import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Phase, StoredPlan } from "./plan.ts";

// What survives a restart: just enough to show a worker as detached, stop a leftover
// process, and resume the conversation. No prompts, tokens or environment values.
// The file is untrusted input: it is validated on load and nothing in it is ever run.

export const STORE_FILE = "managed.json";
export const MAX_STORED = 50;
export const KEEP_MS = 24 * 3_600_000;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Millis = z.number().int().min(0).max(8.64e15);

const Worker = z
  .object({
    id: Id,
    name: z.string().min(1).max(100),
    project: z.string().min(1).max(100),
    task: z.string().max(200),
    cwd: z.string().min(1).max(1000),
    createdAt: Millis,
    updatedAt: Millis,
    pid: z.number().int().min(1).max(2 ** 31 - 1).nullable(),
    processName: z.string().min(1).max(100).nullable(),
    pidStartedAt: Millis.nullable(),
    costUsdTotal: z.number().min(0).max(100_000),
    // Masters only. Files from before the plan gate lack both and still load.
    phase: Phase.optional(),
    plan: StoredPlan.nullable().optional(),
    // Older files lack both. They keep a worker's team and master visible after a restart.
    team: z.literal("research").optional(),
    ownerId: Id.nullable().optional(),
    sweep: z.literal(true).optional(),
    // Older files lack both. They keep a worker's person and task after a restart.
    personId: z.string().regex(/^[0-9a-f]{12}$/).optional(),
    taskId: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  })
  .strict();
const Store = z.object({ version: z.literal(1), workers: z.array(Worker).max(MAX_STORED) }).strict();

export type StoredWorker = z.infer<typeof Worker>;

export type WriteOps = { writeFile: typeof writeFile; rename: typeof rename };
export const realOps: WriteOps = { writeFile, rename };

/** Removes temporary files left by an interrupted write. Call once at startup, before anything is saved. */
export async function cleanTmp(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => n.startsWith(`${STORE_FILE}.`) && n.endsWith(".tmp")).map((n) => rm(join(dir, n), { force: true })));
}

/** Entries not touched for 24 hours are forgotten. Apply this after any cleanup that needs the old entries. */
export const freshOnly = (workers: StoredWorker[], now = Date.now()) => workers.filter((w) => now - w.updatedAt <= KEEP_MS);

/**
 * Reads every stored worker, old ones included. A missing file gives none; a damaged one is set aside
 * as `managed.json.bad`.
 */
export async function loadStore(dir: string): Promise<StoredWorker[]> {
  const file = join(dir, STORE_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const parsed = Store.safeParse(safeJson(text));
  if (!parsed.success) {
    await rename(file, `${file}.bad`).catch(() => {});
    return [];
  }
  return parsed.data.workers;
}

/** Writes the whole file to a temporary name and renames it over the old one, so it is complete or unchanged. */
export async function saveStore(dir: string, workers: StoredWorker[], ops: WriteOps = realOps): Promise<void> {
  await mkdir(dir, { recursive: true });
  const newest = [...workers].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED);
  const tmp = join(dir, `${STORE_FILE}.${process.pid}.tmp`);
  try {
    await ops.writeFile(tmp, JSON.stringify({ version: 1, workers: newest }));
    await renameWithRetry(ops, tmp, join(dir, STORE_FILE));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** On Windows a rename can fail for a moment while another program (or reader) has the target open. */
export async function renameWithRetry(ops: WriteOps, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ops.rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 12 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}
