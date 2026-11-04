import type { ActivityEntry } from "../../shared/events.ts";

export type ActionResult = { ok: true } | { ok: false; message: string };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Plain-language text for an answer from the server. */
export function describeFailure(status: number, code: string | undefined): string {
  switch (code) {
    case "invalid_request":
      return "The request was not valid. Check the folder and the prompt.";
    case "invalid_folder":
      return "That folder does not exist or is not a folder. Use a full path.";
    case "folder_not_allowed":
      return "That folder is not allowed. Add it to OFFICE_ALLOWED_ROOTS and restart the server.";
    case "too_many":
      return "The limit of running workers is reached. Stop one first.";
    case "start_failed":
      return "Claude Code did not start a session. Check that it is installed and logged in with your subscription.";
    case "too_large":
      return "The prompt is too large.";
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
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false, message: describeFailure(res.status, typeof data.error === "string" ? data.error : undefined) };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

export const startWorker = (cwd: string, prompt: string, fetchFn: FetchFn = fetch) =>
  post("/api/agents", { role: "worker", cwd, prompt }, fetchFn);

export const stopAgent = (id: string, fetchFn: FetchFn = fetch) =>
  post(`/api/agents/${encodeURIComponent(id)}/stop`, {}, fetchFn);

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
