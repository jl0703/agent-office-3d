// The Workshop as the page sees it: builds of adopted findings, made in a copy, each ending as a patch to review.

export const STATUSES = ["building", "ready", "no-changes", "too-large", "error"] as const;
export type BuildStatus = (typeof STATUSES)[number];
export const STATUS_WORD: Record<BuildStatus, string> = {
  building: "Building",
  ready: "Patch ready",
  "no-changes": "No changes",
  "too-large": "Patch too large",
  error: "Failed",
};

export const VERDICTS = ["improves", "no-difference", "worse", "unclear"] as const;
export type EvalVerdict = (typeof VERDICTS)[number];
export const VERDICT_WORD: Record<EvalVerdict, string> = { improves: "Improves", "no-difference": "No difference", worse: "Worse", unclear: "Unclear" };

/** The result of a skill eval in short: pass rates with the change and before it, and what it cost. */
export type EvalSummary = { verdict: EvalVerdict; withRate: number | null; baselineRate: number | null; delta: number | null; costUsd: number; capped: boolean; ranAt: number };

export type Build = { id: string; finding: string; title: string; createdAt: number; status: BuildStatus; files: number; changed: number; /** Which try this is (1 to 3) and how the try before it scored. */ round?: number; evalBefore?: EvalSummary; eval?: EvalSummary; evalRun?: { done: number; total: number; failed?: true } };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toBuild(raw: unknown): Build | null {
  if (!isRecord(raw)) return null;
  const { id, finding, title, createdAt, status, files, changed } = raw;
  if (typeof id !== "string" || typeof finding !== "string" || typeof title !== "string" || typeof createdAt !== "number") return null;
  if (!(STATUSES as readonly unknown[]).includes(status) || typeof files !== "number" || typeof changed !== "number") return null;
  return { id, finding, title, createdAt, status: status as BuildStatus, files, changed, ...(typeof raw["round"] === "number" ? { round: raw["round"] } : {}), ...(toSummary(raw["evalBefore"]) ? { evalBefore: toSummary(raw["evalBefore"]) as EvalSummary } : {}), ...(toSummary(raw["eval"]) ? { eval: toSummary(raw["eval"]) as EvalSummary } : {}), ...(toRun(raw["evalRun"]) ? { evalRun: toRun(raw["evalRun"]) as { done: number; total: number; failed?: true } } : {}) };
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

function toSummary(raw: unknown): EvalSummary | undefined {
  if (!isRecord(raw) || !(VERDICTS as readonly unknown[]).includes(raw["verdict"]) || typeof raw["costUsd"] !== "number" || typeof raw["ranAt"] !== "number") return undefined;
  return { verdict: raw["verdict"] as EvalVerdict, withRate: num(raw["withRate"]), baselineRate: num(raw["baselineRate"]), delta: num(raw["delta"]), costUsd: raw["costUsd"], capped: raw["capped"] === true, ranAt: raw["ranAt"] };
}

function toRun(raw: unknown): { done: number; total: number; failed?: true } | undefined {
  return isRecord(raw) && typeof raw["done"] === "number" && typeof raw["total"] === "number" ? { done: raw["done"], total: raw["total"], ...(raw["failed"] === true ? { failed: true as const } : {}) } : undefined;
}

/** The builds, newest first, and the folder they live in; "off" when the Workshop is not set up (404); null when the server cannot be reached or answers oddly. */
export async function getBuilds(fetchFn: FetchFn = fetch): Promise<{ builds: Build[]; dir: string } | "off" | null> {
  try {
    const res = await fetchFn("/api/workshop");
    if (res.status === 404) return "off";
    if (!res.ok) return null;
    const data = (await res.json()) as { builds?: unknown; dir?: unknown };
    return Array.isArray(data.builds) ? { builds: data.builds.map(toBuild).filter((b): b is Build => b !== null), dir: typeof data.dir === "string" ? data.dir : "" } : null;
  } catch {
    return null;
  }
}

export async function getPatch(id: string, fetchFn: FetchFn = fetch): Promise<{ patch: string; truncated: boolean } | null> {
  try {
    const res = await fetchFn(`/api/workshop/${encodeURIComponent(id)}/patch`);
    if (!res.ok) return null;
    const data = (await res.json()) as { patch?: unknown; truncated?: unknown };
    return typeof data.patch === "string" ? { patch: data.patch, truncated: data.truncated === true } : null;
  } catch {
    return null;
  }
}

export type Started = { ok: true } | { ok: false; message: string };

export async function startBuild(findingId: string, fetchFn: FetchFn = fetch): Promise<Started> {
  try {
    const res = await fetchFn("/api/workshop/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ findingId }) });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
    const code = [data.error, data.reason].find((v) => typeof v === "string") as string | undefined;
    const words: Record<string, string> = {
      not_adopted: "Mark the finding Adopt first.",
      too_big: "The target folder is too large to copy (over 2000 files or 50 MB).",
      too_many_builds: "There are already 100 builds. Delete old ones from the workshop folder first.",
      too_many: "Too many agents are running. Stop one first.",
      worker_limit: "Too many workers are running. Stop one first.",
      target_missing: "The target folder could not be found.",
      master_running: "A master is already running. Wait for it or stop it.",
      budget: "The usage cap was reached.",
    };
    if (code && words[code]) return { ok: false, message: words[code] };
    if (res.status === 403) return { ok: false, message: "The session has expired. Open the link printed in the terminal again." };
    return { ok: false, message: `Something went wrong (error ${res.status}).` };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

/** Which lines of a patch were added, removed, or are headers, so the page can colour them. */
export const lineKind = (line: string): "add" | "del" | "head" | "ctx" =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("@@") ? "head" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";

export function demoBuilds(): Build[] {
  return [
    { id: "0123456789ab", finding: "demo-skills-pack", title: "Demo: a pack of documentation skills", createdAt: Date.UTC(2026, 10, 6, 9, 0), status: "ready", files: 12, changed: 2, eval: { verdict: "improves", withRate: 1, baselineRate: 0.5, delta: 0.5, costUsd: 0.62, capped: false, ranAt: Date.UTC(2026, 10, 6, 10, 0) } },
    { id: "0123456789ac", finding: "demo-review-mcp", title: "Demo: a code review MCP server", createdAt: Date.UTC(2026, 10, 5, 9, 0), status: "no-changes", files: 12, changed: 0 },
  ];
}

export const DEMO_PATCH = "diff --git a/docs/SKILL.md b/docs/SKILL.md\n--- a/docs/SKILL.md\n+++ b/docs/SKILL.md\n@@ -1,2 +1,3 @@\n # Docs\n-old line\n+new line\n+another line\n";

/** One side of one case in a full eval result: the answer (cut short) and each check. */
export type EvalSide = { answer: string; checks: { pass: boolean; why: string }[]; passed: number; total: number } | { error: string };
export type EvalCaseResult = { id: number; prompt: string; assertions: string[]; withSkill: EvalSide; baseline: EvalSide } | { id: number; prompt: string; skipped: true };
export type EvalFull = EvalSummary & { skill: string; baseline: "previous version" | "no skill"; durationMs: number; cases: EvalCaseResult[] };

/** The full result of a build's eval; null when there is none. */
export async function getEval(id: string, fetchFn: FetchFn = fetch): Promise<EvalFull | null> {
  try {
    const res = await fetchFn(`/api/workshop/${encodeURIComponent(id)}/eval`);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const summary = toSummary(data);
    return summary && Array.isArray(data["cases"]) ? ({ ...summary, skill: String(data["skill"] ?? ""), baseline: data["baseline"] === "no skill" ? "no skill" : "previous version", durationMs: num(data["durationMs"]) ?? 0, cases: data["cases"] as EvalCaseResult[] }) : null;
  } catch {
    return null;
  }
}

const EVAL_WORDS: Record<string, string> = {
  no_patch: "The build has no patch yet.",
  no_evals: "This build has no test requests: it was made without a brief.",
  no_skill: "The patch does not change a skill (no SKILL.md above the changed files).",
  eval_running: "Another eval is running. Wait for it to finish.",
  no_eval: "Run the skill eval first: the next round learns from its result.",
  rounds_used: "This build has used all three rounds.",
  master_running: "A master is already running. Wait for it or stop it.",
  budget: "The usage cap was reached.",
};

async function startEvalLike(path: string, fetchFn: FetchFn): Promise<Started> {
  try {
    const res = await fetchFn(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
    const code = [data.error, data.reason].find((v) => typeof v === "string") as string | undefined;
    if (code && EVAL_WORDS[code]) return { ok: false, message: EVAL_WORDS[code] };
    if (res.status === 403) return { ok: false, message: "The session has expired. Open the link printed in the terminal again." };
    return { ok: false, message: `Something went wrong (error ${res.status}).` };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

/** Starts the next round: a new plan-first master in the same working copy, given what the eval found. The page asks first. */
export const reviseBuild = (id: string, fetchFn: FetchFn = fetch) => startEvalLike(`/api/workshop/${encodeURIComponent(id)}/revise`, fetchFn);

export const percent = (rate: number | null) => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);

/** Starts a skill eval for a build. The page asks for confirmation first, because it uses model time. */
export const startEval = (id: string, fetchFn: FetchFn = fetch) => startEvalLike(`/api/workshop/${encodeURIComponent(id)}/eval`, fetchFn);
