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

export type Build = { id: string; finding: string; title: string; createdAt: number; status: BuildStatus; files: number; changed: number };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toBuild(raw: unknown): Build | null {
  if (!isRecord(raw)) return null;
  const { id, finding, title, createdAt, status, files, changed } = raw;
  if (typeof id !== "string" || typeof finding !== "string" || typeof title !== "string" || typeof createdAt !== "number") return null;
  if (!(STATUSES as readonly unknown[]).includes(status) || typeof files !== "number" || typeof changed !== "number") return null;
  return { id, finding, title, createdAt, status: status as BuildStatus, files, changed };
}

/** The builds, newest first; "off" when the Workshop is not set up (404); null when the server cannot be reached or answers oddly. */
export async function getBuilds(fetchFn: FetchFn = fetch): Promise<Build[] | "off" | null> {
  try {
    const res = await fetchFn("/api/workshop");
    if (res.status === 404) return "off";
    if (!res.ok) return null;
    const data = (await res.json()) as { builds?: unknown };
    return Array.isArray(data.builds) ? data.builds.map(toBuild).filter((b): b is Build => b !== null) : null;
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
      too_many: "There are already 100 builds. Delete old ones from the workshop folder first.",
      target_missing: "The target folder could not be found.",
      master_running: "A master is already running. Wait for it or stop it.",
      budget: "The usage cap was reached.",
      too_many_workers: "Too many workers are running. Stop one first.",
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
    { id: "0123456789ab", finding: "demo-skills-pack", title: "Demo: a pack of documentation skills", createdAt: Date.UTC(2026, 10, 6, 9, 0), status: "ready", files: 12, changed: 2 },
    { id: "0123456789ac", finding: "demo-review-mcp", title: "Demo: a code review MCP server", createdAt: Date.UTC(2026, 10, 5, 9, 0), status: "no-changes", files: 12, changed: 0 },
  ];
}

export const DEMO_PATCH = "diff --git a/docs/SKILL.md b/docs/SKILL.md\n--- a/docs/SKILL.md\n+++ b/docs/SKILL.md\n@@ -1,2 +1,3 @@\n # Docs\n-old line\n+new line\n+another line\n";
