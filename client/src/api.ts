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
