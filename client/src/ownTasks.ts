// The owner's own tasks, kept by the server. The board shows them next to the work the agents are doing.
import { describeFailure } from "./api.ts";

export type OwnTask = { id: string; title: string; details: string; assignee: string | null; done: boolean; agentId: string | null; createdAt: number };
export type TaskFields = { title: string; details: string; assignee: string | null };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
export type TasksResult = { ok: true; tasks: OwnTask[]; id?: string } | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function toOwnTask(raw: unknown): OwnTask | null {
  if (!isRecord(raw)) return null;
  const { id, title, details, assignee, done, agentId, createdAt } = raw;
  if (typeof id !== "string" || typeof title !== "string" || typeof details !== "string" || typeof done !== "boolean" || typeof createdAt !== "number") return null;
  if ((assignee !== null && typeof assignee !== "string") || (agentId !== null && typeof agentId !== "string")) return null;
  return { id, title, details, assignee, done, agentId, createdAt };
}

const toTasks = (raw: unknown): OwnTask[] | null => {
  const list = isRecord(raw) ? raw["tasks"] : null;
  if (!Array.isArray(list)) return null;
  const tasks = list.map(toOwnTask);
  return tasks.every((t): t is OwnTask => t !== null) ? tasks : null;
};

/** The owner's tasks, or null when they cannot be read (or the server has none). */
export async function getOwnTasks(fetchFn: FetchFn = fetch): Promise<OwnTask[] | null> {
  try {
    const res = await fetchFn("/api/tasks");
    return res.ok ? toTasks(await res.json()) : null;
  } catch {
    return null;
  }
}

const FAILURES: Record<string, string> = {
  no_assignee: "Give the task to a person first.",
  task_running: "That task is already being worked on. Wait for its plan or its result.",
  unknown_person: "That person is no longer on the team.",
  unknown_task: "That task no longer exists.",
  too_many: "There are too many tasks (200 at most). Remove some first.",
  invalid_request: "Check the fields: a title is needed (one line, up to 100 characters); the details are up to 1500.",
};

async function change(path: string, body: Record<string, unknown>, fetchFn: FetchFn): Promise<TasksResult> {
  try {
    const res = await fetchFn(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirm: true }) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      const tasks = toTasks(data);
      return tasks ? { ok: true, tasks, ...(typeof data["id"] === "string" ? { id: data["id"] } : {}) } : { ok: false, message: "The server's answer could not be read." };
    }
    const code = [data["reason"], data["error"]].find((v) => typeof v === "string") as string | undefined;
    return { ok: false, message: (code && FAILURES[code]) || describeFailure(res.status, code) };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

export const addTask = (fields: TaskFields, fetchFn: FetchFn = fetch) => change("/api/tasks", fields, fetchFn);
export const updateTask = (id: string, fields: Partial<TaskFields & { done: boolean }>, fetchFn: FetchFn = fetch) => change("/api/tasks/update", { id, ...fields }, fetchFn);
export const removeTask = (id: string, fetchFn: FetchFn = fetch) => change("/api/tasks/remove", { id }, fetchFn);
/** Starts a worker in the person's role for this task, in the given folder. Its plan waits for the owner. */
export const startTask = (id: string, cwd: string, fetchFn: FetchFn = fetch) => change("/api/tasks/start", { id, cwd }, fetchFn);

export function demoOwnTasks(): OwnTask[] {
  const id = (n: number) => n.toString(16).padStart(12, "0");
  return [
    { id: id(101), title: "Make the header sticky", details: "It scrolls away on long pages.", assignee: id(4), done: false, agentId: null, createdAt: Date.UTC(2026, 10, 8, 9) },
    { id: id(102), title: "Add tests for the login route", details: "", assignee: id(6), done: false, agentId: null, createdAt: Date.UTC(2026, 10, 8, 10) },
    { id: id(103), title: "Plan next month's work", details: "", assignee: null, done: false, agentId: null, createdAt: Date.UTC(2026, 10, 8, 11) },
    { id: id(104), title: "Update the README", details: "", assignee: id(5), done: true, agentId: null, createdAt: Date.UTC(2026, 10, 7, 9) },
  ];
}
