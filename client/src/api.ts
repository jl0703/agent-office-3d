import type { ActivityEntry } from "../../shared/events.ts";
import type { VaultInfo } from "../../shared/vault.ts";

export type ActionResult = { ok: true } | { ok: false; message: string };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Plain-language text for an answer from the server. */
export function describeFailure(status: number, code: string | undefined): string {
  switch (code) {
    case "invalid_request":
      return "The request was not valid. Check the folder and the prompt.";
    case "invalid_folder":
      return "That folder does not exist or is not a folder. Check the path (a full path is needed).";
    case "folder_not_allowed":
      return "That folder is not allowed (or is no longer allowed). Add it to OFFICE_ALLOWED_ROOTS and restart the server.";
    case "too_many":
      return "The limit of running workers is reached. Stop one first.";
    case "start_failed":
      return "Claude Code did not start a session. Check that it is installed and logged in with your subscription.";
    case "too_large":
      return "The prompt is too large.";
    case "no_research_folder":
      return "There is no research folder yet. Set OFFICE_VAULT_DIR (or OFFICE_RESEARCH_DIR) in the .env file and restart the server.";
    case "master_running":
      return "A master is already running. Stop it first, or give it a new goal.";
    case "master_not_resumable":
      return "A master cannot be resumed. Start a new master with the goal, so it plans and waits for your approval.";
    case "no_pending_plan":
      return "There is no plan waiting for an answer (it may have been answered already).";
    case "busy":
      return "That worker is occupied with an earlier task. Wait for it to finish.";
    case "stopped":
      return "That worker has ended. Resume it first.";
    case "detached":
      return "That worker lost its connection when the server restarted. Resume it first.";
    case "observed":
      return "That session was started elsewhere, so this page can only watch it.";
    case "not_resumable":
      return "That worker is still running, so there is nothing to resume.";
    case "transcript_active":
      return "That conversation was in use a moment ago. Close any other Claude Code window using it, wait a few seconds, and try again.";
    case "budget":
      return "The usage cap has been reached. Raise it in the server settings and restart to continue.";
    case "not_found":
      return "That worker no longer exists.";
  }
  if (status === 403) return "The session has expired. Open the one-time URL printed in the terminal again.";
  return `Something went wrong (error ${status}).`;
}

async function post(path: string, body: unknown, fetchFn: FetchFn): Promise<ActionResult> {
  try {
    const res = await fetchFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    // A conflict explains itself in `reason`; other refusals use `error`.
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
    const code = [data.error, data.reason].find((value) => typeof value === "string");
    return { ok: false, message: describeFailure(res.status, code as string | undefined) };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

export const startWorker = (cwd: string, prompt: string, fetchFn: FetchFn = fetch) =>
  post("/api/agents", { role: "worker", cwd, prompt }, fetchFn);

/** A research team: a lead and up to three scouts that look at GitHub and write a report in the research folder. */
export const startResearch = (topic: string, fetchFn: FetchFn = fetch) =>
  post("/api/agents", { role: "master", team: "research", prompt: topic }, fetchFn);

/** A master gets a goal, splits it up and runs workers of its own. */
export const startMaster = (cwd: string, goal: string, fetchFn: FetchFn = fetch) =>
  post("/api/agents", { role: "master", cwd, prompt: goal }, fetchFn);

/** The owner's answer to a master's plan: approve it, ask for changes (with a note) or reject it. */
export const decidePlan = (id: string, decision: "approve" | "changes" | "reject", note: string | undefined, fetchFn: FetchFn = fetch) =>
  post(`/api/agents/${encodeURIComponent(id)}/plan`, { decision, ...(note ? { note } : {}) }, fetchFn);

export const stopAgent = (id: string, fetchFn: FetchFn = fetch) =>
  post(`/api/agents/${encodeURIComponent(id)}/stop`, {}, fetchFn);

export const assignTask = (id: string, prompt: string, fetchFn: FetchFn = fetch) =>
  post(`/api/agents/${encodeURIComponent(id)}/tasks`, { prompt }, fetchFn);

export const resumeAgent = (id: string, prompt: string, fetchFn: FetchFn = fetch) =>
  post(`/api/agents/${encodeURIComponent(id)}/resume`, { prompt }, fetchFn);

export const stopAll = (fetchFn: FetchFn = fetch) => post("/api/agents/stop-all", {}, fetchFn);

/** The last 50 tool calls of one agent, or null when the server has no such agent or cannot be reached. */
export async function getAgentEvents(id: string, fetchFn: FetchFn = fetch): Promise<ActivityEntry[] | null> {
  try {
    const res = await fetchFn(`/api/agents/${encodeURIComponent(id)}/events`);
    if (!res.ok) return null;
    const data = (await res.json()) as { events?: unknown };
    return Array.isArray(data.events) ? (data.events as ActivityEntry[]) : null;
  } catch {
    return null;
  }
}

/** What the knowledge hub shows, or null when the server cannot be reached or answers with something else. */
export async function getVault(refresh = false, fetchFn: FetchFn = fetch): Promise<VaultInfo | null> {
  try {
    const res = await fetchFn(refresh ? "/api/vault?refresh=1" : "/api/vault");
    if (!res.ok) return null;
    const data = (await res.json()) as { connected?: unknown };
    return typeof data.connected === "boolean" ? (data as VaultInfo) : null;
  } catch {
    return null;
  }
}

export type Usage = { totalUsd: number; caps: { runUsd: number; sessionUsd: number; totalUsd: number } };

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Estimated usage since the server started, with the caps; null when the server cannot be reached or answers oddly. */
export async function getUsage(fetchFn: FetchFn = fetch): Promise<Usage | null> {
  try {
    const res = await fetchFn("/api/usage");
    if (!res.ok) return null;
    const data = (await res.json()) as { totalUsd?: unknown; caps?: { runUsd?: unknown; sessionUsd?: unknown; totalUsd?: unknown } };
    const caps = data.caps;
    if (!isNumber(data.totalUsd) || !caps || !isNumber(caps.runUsd) || !isNumber(caps.sessionUsd) || !isNumber(caps.totalUsd)) return null;
    return { totalUsd: data.totalUsd, caps: { runUsd: caps.runUsd, sessionUsd: caps.sessionUsd, totalUsd: caps.totalUsd } };
  } catch {
    return null;
  }
}

/** The last final answer of a worker started here: its text, null when there is none yet, undefined when it could not be read. */
export async function getAgentResult(id: string, fetchFn: FetchFn = fetch): Promise<string | null | undefined> {
  try {
    const res = await fetchFn(`/api/agents/${encodeURIComponent(id)}/result`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { result?: unknown };
    return typeof data.result === "string" ? data.result : data.result === null ? null : undefined;
  } catch {
    return undefined;
  }
}

export type AutoApprove = { enabled: boolean; maxCostUsd: number; maxWorkers: number };

export async function getAutoApprove(fetchFn: FetchFn = fetch): Promise<AutoApprove | null> {
  try {
    const res = await fetchFn("/api/auto-approve");
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<AutoApprove>;
    return typeof d.enabled === "boolean" && typeof d.maxCostUsd === "number" && typeof d.maxWorkers === "number" ? { enabled: d.enabled, maxCostUsd: d.maxCostUsd, maxWorkers: d.maxWorkers } : null;
  } catch {
    return null;
  }
}

export const setAutoApprove = (change: Partial<AutoApprove>, fetchFn: FetchFn = fetch) => post("/api/auto-approve", change, fetchFn);
