import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { realOps, renameWithRetry, type WriteOps } from "./managedStore.ts";
import { isInside } from "./paths.ts";
import { PLAN_NOTE } from "./plan.ts";

// Opt-in auto-approval of small plans. The setting lives in one file in the data folder. The numbers in a plan are
// the master's own claim: they only decide whether the owner is asked. The real caps still apply either way.

export const AUTO_APPROVE_FILE = "auto-approve.json";
export const MAX_AUTO_FILES = 5;

const Fields = {
  enabled: z.boolean(),
  maxCostUsd: z.number().min(0).max(2),
  maxWorkers: z.number().int().min(0).max(3),
};
const AutoApproveFile = z.object({ version: z.literal(1), ...Fields }).strict();
export type AutoApprove = z.infer<z.ZodObject<typeof Fields>>;
export const AutoApproveBody = z
  .object(Fields)
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0);

const DEFAULT: AutoApprove = { enabled: false, maxCostUsd: 0.5, maxWorkers: 1 };

/** The settings file: strict shape, atomic writes (temporary file, then rename), a damaged file is set aside as `.bad` and reads as the defaults (off). */
export function createAutoApproveStore(dir: string, ops: WriteOps = realOps) {
  const file = join(dir, AUTO_APPROVE_FILE);
  let current: Promise<AutoApprove> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const load = () =>
    (current ??= (async (): Promise<AutoApprove> => {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return { ...DEFAULT };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      const parsed = AutoApproveFile.safeParse(raw);
      if (!parsed.success) {
        await rename(file, `${file}.bad`).catch(() => {});
        return { ...DEFAULT };
      }
      const { enabled, maxCostUsd, maxWorkers } = parsed.data;
      return { enabled, maxCostUsd, maxWorkers };
    })());

  async function save(next: AutoApprove) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await ops.writeFile(tmp, JSON.stringify({ version: 1, ...next }));
      await renameWithRetry(ops, tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  return {
    get: () => enqueue(async () => ({ ...(await load()) })),
    /** Merges `change` into the stored settings and saves. The cache only moves on after the write worked. */
    update: (change: Partial<AutoApprove>) =>
      enqueue(async () => {
        const next = { ...(await load()), ...change };
        await save(next);
        current = Promise.resolve(next);
        return { ...next };
      }),
  };
}
export type AutoApproveStore = ReturnType<typeof createAutoApproveStore>;

const DRIVE = /^[A-Za-z]:[\\/]/;

/** The nearest existing ancestor is resolved through links, so a link inside the folder cannot lead out of it. The file itself may not exist yet. */
async function resolvesInside(realCwd: string, file: string, cwd: string): Promise<boolean> {
  if (!file || !PLAN_NOTE.test(file)) return false;
  if (/^[\\/]{2}/.test(file)) return false; // UNC and device paths
  if (DRIVE.test(file) && process.platform !== "win32") return false; // a Windows drive path is never a plain name inside the folder elsewhere
  if (file.slice(DRIVE.test(file) ? 2 : 0).includes(":")) return false; // drive-relative names and alternate streams
  if (file.split(/[\\/]/).includes("..")) return false;
  let existing = resolve(cwd, file);
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return false;
      tail.unshift(relative(parent, existing));
      existing = parent;
    }
  }
  const target = join(existing, ...tail);
  return target !== realCwd && isInside(realCwd, target);
}

/** True when the plan lists 1 to 5 files and every one is inside the master's folder. */
export async function filesInsideFolder(files: string[], cwd: string): Promise<boolean> {
  if (files.length < 1 || files.length > MAX_AUTO_FILES) return false;
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    return false;
  }
  for (const file of files) if (!(await resolvesInside(realCwd, file, cwd))) return false;
  return true;
}

// A path that starts at a root or home (C:\, \\, ~/, /name) or climbs out with `..`, written anywhere in the plan's text.
// Over-cautious on purpose: a route like /api/users also sends the plan to the owner.
const OUTSIDE_PATH = /(?:^|[\s"'`([{<>=,;|&])(?:[A-Za-z]:[\\/]|\\|~\w*[\\/]|\/(?!\/?\s)[^\s]|[$%]\w)|(?:^|[\\/\s"'`([{<>=,;:|&])\.\.(?=[\\/\s)\];,:]|$)/m;

/** True when the plan's own words point outside the master's folder. */
export const namesOutsidePath = (plan: { goal: string; steps: string[]; risks: string; undo: string }) =>
  [plan.goal, ...plan.steps, plan.risks, plan.undo].some((text) => OUTSIDE_PATH.test(text));
