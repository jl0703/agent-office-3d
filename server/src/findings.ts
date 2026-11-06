import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isInside } from "./paths.ts";
import { realOps, renameWithRetry, type WriteOps } from "./managedStore.ts";

// The Research department's data: findings are markdown notes written by agents (untrusted text),
// decisions are the user's own and live in the app's data folder. Only the frontmatter of a note is ever
// read, and only its first 8 KB; a note's body never leaves the disk.

export const FINDINGS_DIR = "findings";
export const FOCUS_FILE = "focus.md";
export const NEEDS_FILE = "office-needs.md";
export const HEAD_BYTES = 8 * 1024;
export const MAX_FINDING_FILES = 500;
export const MAX_FOCUS_LINES = 20;
export const MAX_FOCUS_CHARS = 100;
export const MAX_NEEDS_CHARS = 4000;
export const MAX_DECISIONS = 1000;
export const DECISIONS_FILE = "research-decisions.json";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KINDS = ["skill", "mcp", "repo", "idea", "technique"] as const;
const LEVELS = ["low", "medium", "high"] as const;
export const STATUSES = ["new", "looking", "adopt", "later", "reject"] as const;
export type Status = (typeof STATUSES)[number];

export type Finding = {
  id: string;
  kind: (typeof KINDS)[number];
  title: string;
  url: string;
  stars?: number;
  license?: string;
  relevance: number;
  effort: (typeof LEVELS)[number];
  risk: (typeof LEVELS)[number];
  found_by: string;
  date: string;
  why: string;
};
export type FindingView = Finding & { status: Status; note?: string };

// Control, format (bidi, zero-width) and line-separator characters never belong in a one-line field.
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029\uFFFD]/u;
const UNSAFE_G = new RegExp(UNSAFE.source, "gu");
const LINE = /^([A-Za-z_][A-Za-z0-9_-]{0,39}):[ ]*(.*)$/;

const oneLine = (max: number) => z.string().min(1).max(max).refine((v) => !UNSAFE.test(v));
const optional = (v: string | undefined) => (v === "" ? undefined : v);

const Fields = z.object({
  id: z.string().regex(SLUG),
  kind: z.enum(KINDS),
  title: oneLine(120),
  url: z.string().max(300).regex(/^https:\/\/[^\s]+$/).refine(isPlainHttps),
  stars: z.string().regex(/^\d{1,9}$/).optional(),
  license: oneLine(40).optional(),
  relevance: z.string().regex(/^[1-5]$/),
  effort: z.enum(LEVELS),
  risk: z.enum(LEVELS),
  found_by: oneLine(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate),
  why: oneLine(400),
});

function isPlainHttps(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

function isRealDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/** Parses the frontmatter of one note's first bytes. Returns null for anything that is not exactly the documented format. */
export function parseFrontmatter(head: string, fileId: string): Finding | null {
  if (head.includes("\0")) return null;
  const lines = head.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close === -1 || close > 60) return null; // the closing line must be inside the head we read
  const raw = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    if (UNSAFE.test(line)) return null;
    if (line.trim() === "") continue;
    const m = LINE.exec(line);
    const key = m?.[1];
    if (!m || key === undefined || raw.has(key)) return null; // not "key: value", or a repeated key
    raw.set(key, (m[2] ?? "").trim());
  }
  const parsed = Fields.safeParse({
    id: raw.get("id"),
    kind: raw.get("kind"),
    title: raw.get("title"),
    url: raw.get("url"),
    stars: optional(raw.get("stars")),
    license: optional(raw.get("license")),
    relevance: raw.get("relevance"),
    effort: raw.get("effort"),
    risk: raw.get("risk"),
    found_by: raw.get("found_by"),
    date: raw.get("date"),
    why: raw.get("why"),
  });
  if (!parsed.success || parsed.data.id !== fileId) return null;
  const { stars, license, relevance, ...rest } = parsed.data;
  return { ...rest, ...(stars === undefined ? {} : { stars: Number(stars) }), ...(license === undefined ? {} : { license }), relevance: Number(relevance) };
}

/** The research folder's real path, or null when it is missing or not a folder. */
export async function resolveResearch(dir: string | undefined): Promise<string | null> {
  if (!dir) return null;
  try {
    const real = await realpath(dir);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Opens a regular file that really lives inside `base` (links are followed and checked) and reads at most
 * `maxBytes` of it. Missing, odd or escaping files give null.
 */
async function readHead(base: string, name: string, maxBytes: number): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const path = join(base, name);
    let real = path;
    if ((await lstat(path)).isSymbolicLink()) {
      real = await realpath(path);
      if (!isInside(await realpath(base), real)) return null;
    }
    const info = await stat(real);
    if (!info.isFile()) return null;
    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), mtimeMs: info.mtimeMs };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** The findings folder's real path when it is a folder inside the research folder. */
async function findingsBase(researchReal: string): Promise<string | null> {
  try {
    const real = await realpath(join(researchReal, FINDINGS_DIR));
    return isInside(researchReal, real) && (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** One finding by id, or null when its file is missing or invalid. */
export async function readFinding(researchReal: string, id: string): Promise<Finding | null> {
  if (!SLUG.test(id)) return null;
  const base = await findingsBase(researchReal);
  const head = base && (await readHead(base, `${id}.md`, HEAD_BYTES));
  return head ? parseFrontmatter(head.text, id) : null;
}

/** Every valid finding (newest first) and the number of note files that were ignored. */
export async function readFindings(researchReal: string): Promise<{ findings: Finding[]; invalid: number }> {
  const base = await findingsBase(researchReal);
  if (!base) return { findings: [], invalid: 0 };
  const names = (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((e) => !e.isDirectory() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  let invalid = Math.max(0, names.length - MAX_FINDING_FILES);
  const rows: { finding: Finding; mtimeMs: number }[] = [];
  for (const name of names.slice(0, MAX_FINDING_FILES)) {
    const head = await readHead(base, name, HEAD_BYTES);
    const finding = head ? parseFrontmatter(head.text, name.slice(0, -3)) : null;
    if (head && finding) rows.push({ finding, mtimeMs: head.mtimeMs });
    else invalid++;
  }
  rows.sort((a, b) => b.finding.date.localeCompare(a.finding.date) || b.mtimeMs - a.mtimeMs || a.finding.id.localeCompare(b.finding.id));
  // One card per link: the newest note for a URL wins.
  const seen = new Set<string>();
  const findings = rows.map((r) => r.finding).filter((f) => {
    const key = f.url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { findings, invalid };
}

// ---- decisions ----

const Decision = z.object({ status: z.enum(STATUSES), note: z.string().max(300).optional(), updatedAt: z.string().max(40) }).strict();
const DecisionFile = z.object({ version: z.literal(1), decisions: z.record(z.string().regex(SLUG), Decision) }).strict();
export type Decision = z.infer<typeof Decision>;

const NOTE = /^[^\p{Cc}\p{Cf}\u2028\u2029\uFFFD]*$/u;
export const DecisionBody = z
  .object({ status: z.enum(STATUSES), note: z.string().max(300).regex(NOTE).optional() })
  .strict();

/**
 * The user's decisions, in one file in the data folder. Writes are queued and atomic (temporary file, then
 * rename). A damaged file is set aside as `.bad`.
 */
export function createDecisionStore(dir: string, ops: WriteOps = realOps, now: () => number = Date.now) {
  const file = join(dir, DECISIONS_FILE);
  let loaded: Promise<Map<string, Decision>> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const load = () =>
    (loaded ??= (async () => {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return new Map<string, Decision>();
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const parsed = DecisionFile.safeParse(json);
      if (!parsed.success || Object.keys(parsed.data.decisions).length > MAX_DECISIONS) {
        await rename(file, `${file}.bad`).catch(() => {});
        return new Map<string, Decision>();
      }
      return new Map(Object.entries(parsed.data.decisions));
    })());

  async function save(map: Map<string, Decision>) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await ops.writeFile(tmp, JSON.stringify({ version: 1, decisions: Object.fromEntries(map) }));
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
    all: () => enqueue(async () => new Map(await load())),
    /** Records a decision. "new" without a note means "no decision" and removes the entry. */
    set: (id: string, body: z.infer<typeof DecisionBody>) =>
      enqueue(async (): Promise<"ok" | "full"> => {
        const map = await load();
        const next = new Map(map);
        if (body.status === "new" && !body.note) next.delete(id);
        else if (!next.has(id) && next.size >= MAX_DECISIONS) return "full";
        else next.set(id, { status: body.status, ...(body.note ? { note: body.note } : {}), updatedAt: new Date(now()).toISOString() });
        await save(next);
        map.clear();
        for (const [k, v] of next) map.set(k, v);
        return "ok";
      }),
  };
}
export type DecisionStore = ReturnType<typeof createDecisionStore>;

export function withDecisions(findings: Finding[], decisions: Map<string, Decision>): FindingView[] {
  return findings.map((f) => {
    const d = decisions.get(f.id);
    return { ...f, status: d?.status ?? "new", ...(d?.note ? { note: d.note } : {}) };
  });
}

// ---- focus and needs notes ----

export const DEFAULT_FOCUS = ["claude skills and agent skills", "mcp servers for code review and testing", "agent orchestration and memory", "reverse engineering tooling"];
export const DEFAULT_NEEDS = `# What our office needs

Our office is a local 3D workspace that watches Claude Code sessions, starts workers and masters, and has usage caps.

Needs, most important first:
- Better visibility of what agents do (clear activity, results and costs).
- More autonomy with safe limits (agents that can do more on their own without leaving their folder or spending past a cap).
- Better decisions: research before building, not after.
- More productivity for the person using it (fewer manual steps, less waiting and re-explaining).
- Reusable skills and MCP servers that fit a locked-down worker that has no shell (file tools and web search only).
- Licence and maintenance safety: permissive licence, recent activity, and few permissions needed.
`;

const TEXT_OK = /^[^\p{Cc}\p{Cf}\u2028\u2029\uFFFD]*$/u;
export const ConfigBody = z
  .object({
    focus: z.array(z.string().trim().min(1).max(MAX_FOCUS_CHARS).regex(TEXT_OK).refine((v) => !v.startsWith("#"))).max(MAX_FOCUS_LINES),
    needs: z.string().max(MAX_NEEDS_CHARS).refine((v) => !/[\p{Cf}\uFFFD]|(?![\t\r\n])\p{Cc}/u.test(v)),
  })
  .strict();

export type Config = { focus: string[]; needs: string };

/** Creates `findings/` and, only when they are missing, the two default notes. Never overwrites. */
export async function ensureResearchLayout(dir: string): Promise<void> {
  await mkdir(join(dir, FINDINGS_DIR), { recursive: true });
  for (const [name, text] of [[FOCUS_FILE, DEFAULT_FOCUS.join("\n") + "\n"], [NEEDS_FILE, DEFAULT_NEEDS]] as const) {
    await writeFile(join(dir, name), text, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
}

/** Reads the two notes (missing or odd files read as empty). Lines are trimmed; blank lines and "#" headings are skipped. */
export async function readConfig(researchReal: string): Promise<Config> {
  const focusText = (await readHead(researchReal, FOCUS_FILE, 16 * 1024))?.text ?? "";
  const focus = focusText
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").replace(UNSAFE_G, "").trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .slice(0, MAX_FOCUS_LINES)
    .map((l) => [...l].slice(0, MAX_FOCUS_CHARS).join(""));
  const needsText = (await readHead(researchReal, NEEDS_FILE, 16 * 1024))?.text ?? "";
  return { focus, needs: [...needsText.replace(/\0/g, "").trim()].slice(0, MAX_NEEDS_CHARS).join("") };
}

/**
 * Writes both notes inside the research folder, each through a temporary file in that same folder and a
 * rename. A rename replaces a link instead of following it, so nothing can be written outside.
 */
export async function writeConfig(researchReal: string, config: Config, ops: WriteOps = realOps): Promise<void> {
  const files: [string, string][] = [
    [FOCUS_FILE, config.focus.length > 0 ? config.focus.join("\n") + "\n" : ""],
    [NEEDS_FILE, config.needs.trim() === "" ? "" : config.needs.trim() + "\n"],
  ];
  for (const [name, text] of files) {
    const tmp = join(researchReal, `.${name}.${process.pid}.tmp`);
    try {
      await ops.writeFile(tmp, text);
      await renameWithRetry(ops, tmp, join(researchReal, name));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
}
