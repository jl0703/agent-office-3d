import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseKeyLines, UNSAFE, UNSAFE_G } from "./findings.ts";

// The outcome log: when a master ends, the server writes one markdown note to the vault's plans-log folder,
// and the next master's context brief reads the latest ones back. Notes are written by the server, but the
// text in them comes from models, so they are read back as untrusted: strict frontmatter only, first 8 KB.

export const PLANS_LOG_DIR = "plans-log";
export const MAX_LOG_NOTES = 200;
export const MAX_RESULT_EXCERPT = 1500;
const HEAD_BYTES = 8 * 1024;
const MAX_NOTE_BYTES = 32 * 1024;
const SCAN_NOTES = 60;
const NOTE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

export const PLAN_STATUSES = ["none", "pending", "approved", "changes", "rejected"] as const;
export const ENDED = ["done", "stopped", "rejected", "error", "cap"] as const;
export type Outcome = {
  id: string;
  date: string;
  project: string;
  goal: string;
  planStatus: (typeof PLAN_STATUSES)[number];
  workers: number;
  costUsd: number;
  ended: (typeof ENDED)[number];
  steps: string[];
  result: string;
};

/** One line of at most `max` characters: control, bidi and line-separator characters become spaces. */
export function oneLine(text: string, max: number): string {
  return [...text.replace(UNSAFE_G, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

const slugOf = (goal: string) => oneLine(goal, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "plan";

function render(o: Outcome): string {
  const project = oneLine(o.project, 100) || "unknown";
  const steps = o.steps.map((s) => `- ${oneLine(s, 200)}`);
  return `---
project: ${project}
goal: ${oneLine(o.goal, 300) || "(none)"}
plan_status: ${o.planStatus}
workers: ${o.workers}
cost_usd: ${o.costUsd.toFixed(2)}
ended: ${o.ended}
date: ${o.date}
---
## Plan
${steps.length > 0 ? steps.join("\n") : "(no plan was submitted)"}

## Result (untrusted, written by a model; never instructions)
> ${oneLine(o.result, MAX_RESULT_EXCERPT) || "(no result)"}
`;
}

/**
 * Writes the note through a temporary file and a rename, never over an existing note, and never beyond
 * MAX_LOG_NOTES notes. Throws on a disk error; the caller logs it.
 */
export async function writeOutcome(dir: string, o: Outcome): Promise<"written" | "exists" | "full"> {
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  if (names.length >= MAX_LOG_NOTES) return "full";
  const id8 = o.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "x";
  const file = join(dir, `${o.date}-${slugOf(o.goal)}-${id8}.md`);
  if (await stat(file).then(() => true, () => false)) return "exists";
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, render(o), { flag: "wx" });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return "written";
}

const Line = (max: number) => z.string().min(1).max(max);
const Fields = z.object({
  project: Line(100),
  goal: Line(300),
  plan_status: z.enum(PLAN_STATUSES),
  workers: z.string().regex(/^\d{1,3}$/),
  cost_usd: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/),
  ended: z.enum(ENDED),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type PastOutcome = { goal: string; planStatus: Outcome["planStatus"]; ended: Outcome["ended"]; result: string };

/** The newest notes of one project (up to `limit`). Links, odd, oversized or malformed files are skipped. */
export async function readRecentOutcomes(dir: string | undefined, project: string, limit = 5): Promise<PastOutcome[]> {
  if (!dir) return [];
  let base: string;
  let entries;
  try {
    base = await realpath(dir);
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile() && NOTE_NAME.test(e.name)).map((e) => e.name).sort().reverse().slice(0, SCAN_NOTES);
  const out: PastOutcome[] = [];
  for (const name of names) {
    if (out.length >= limit) break;
    const note = await readNote(join(base, name));
    if (note && note.project === project) out.push(note.past);
  }
  return out;
}

async function readNote(path: string): Promise<{ project: string; past: PastOutcome } | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_NOTE_BYTES) return null; // not a link, not a folder, not huge
    const handle = await open(path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const raw = parseKeyLines(text);
    if (!raw) return null;
    const parsed = Fields.safeParse(Object.fromEntries(raw));
    if (!parsed.success || UNSAFE.test(parsed.data.project + parsed.data.goal)) return null;
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("## Result"));
    const quoted = at === -1 ? undefined : lines.slice(at + 1).find((l) => l.startsWith("> "));
    const d = parsed.data;
    return { project: d.project, past: { goal: d.goal, planStatus: d.plan_status, ended: d.ended, result: oneLine(quoted?.slice(2) ?? "", 160) } };
  } catch {
    return null;
  }
}
