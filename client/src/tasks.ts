// The Tasks board: what the agents are doing, sorted into four columns. Read-only; it follows the state of the work and is never edited by hand.
import type { Agent } from "../../shared/events.ts";
import type { Finding } from "./research.ts";
import { STATUS_WORD, VERDICT_WORD, type Build } from "./workshop.ts";

export const COLUMNS = ["active", "progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_WORD: Record<Column, string> = { active: "Active", progress: "In progress", review: "Review", done: "Done" };
export const COLUMN_EMPTY: Record<Column, string> = {
  active: "Finds you adopted that nobody has built yet appear here.",
  progress: "Workers, masters and builds that are working right now appear here.",
  review: "Plans to approve, patches to look at and runs that need you appear here.",
  done: "Finished runs and builds appear here.",
};
export const DONE_LIMIT = 20;

/** Where a card leads: an agent's panel in the office, or a find's own page. */
export type Target = { agent: string } | { find: string };
export type Task = { id: string; column: Column; title: string; who: string; text: string; chip: string; at: number; target: Target };

const short = (text: string, max = 100) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("") + "…";
};
const time = (iso: string) => (Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0);

function agentTask(a: Agent): Task | null {
  if (a.kind === "subagent" || a.status === "detached") return null;
  const base = { id: `agent-${a.id}`, title: a.name, who: a.role === "master" ? "Master" : a.role === "worker" ? "Worker" : "Session", at: time(a.updatedAt), target: { agent: a.id } };
  const text = short(a.currentTask ?? a.activity ?? a.note ?? "");
  if (a.phase === "planning" && a.plan?.status === "pending") return { ...base, column: "review", text: short(`Plan to approve: ${a.plan.goal}`), chip: "Plan waits for you" };
  if (a.status === "error") return { ...base, column: "review", text: short(a.note ?? a.activity ?? "Open it to see what went wrong"), chip: "Failed" };
  if (a.status === "waiting") return { ...base, column: "review", text: short(a.note ?? "Open it to see why"), chip: "Waiting" };
  if (a.status === "working") return { ...base, column: "progress", text, chip: a.phase === "planning" ? "Planning" : "Working" };
  return { ...base, column: "done", text, chip: a.status === "stopped" ? "Stopped" : "Finished" };
}

function buildTask(b: Build): Task {
  const base = { id: `build-${b.id}`, title: b.title, who: "Workshop", at: b.createdAt, target: { find: b.finding } };
  const round = (b.round ?? 1) > 1 ? ` (round ${b.round})` : "";
  if (b.status === "building") return { ...base, column: "progress", text: b.evalRun && !b.evalRun.failed ? `Eval running: ${b.evalRun.done} of ${b.evalRun.total}` : `Building the change${round}`, chip: "Building" };
  if (b.status === "ready") return { ...base, column: "review", text: b.eval ? `Eval: ${VERDICT_WORD[b.eval.verdict]}. ${b.changed} files changed${round}` : `${b.changed} files changed${round}, no eval yet`, chip: STATUS_WORD.ready };
  if (b.status === "error") return { ...base, column: "review", text: "The build failed. Open the find to see why.", chip: STATUS_WORD.error };
  return { ...base, column: "done", text: b.status === "no-changes" ? "The master changed nothing." : "The patch was too large to keep.", chip: STATUS_WORD[b.status] };
}

/** Every card, sorted into columns; the newest first in each, and only the newest few in Done. */
export function tasksOf(agents: readonly Agent[], builds: readonly Build[], findings: readonly Finding[]): Record<Column, Task[]> {
  const built = new Set(builds.map((b) => b.finding));
  const adopted: Task[] = findings
    .filter((f) => f.status === "adopt" && !built.has(f.id))
    .map((f) => ({ id: `find-${f.id}`, column: "active", title: f.title, who: "Research", text: short(f.why), chip: "Adopted", at: time(f.date), target: { find: f.id } }));
  const all = [...adopted, ...builds.map(buildTask), ...agents.map(agentTask).filter((t): t is Task => t !== null)];
  const columns: Record<Column, Task[]> = { active: [], progress: [], review: [], done: [] };
  for (const t of all.sort((x, y) => y.at - x.at || x.id.localeCompare(y.id))) columns[t.column].push(t);
  columns.done = columns.done.slice(0, DONE_LIMIT);
  return columns;
}
