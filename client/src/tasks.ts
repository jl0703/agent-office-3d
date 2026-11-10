// The Tasks board: the owner's tasks and what the agents are doing, sorted into four columns. A column follows the state of the work, so cards are never dragged.
import type { Agent } from "../../shared/events.ts";
import type { OwnTask } from "./ownTasks.ts";
import type { Finding } from "./research.ts";
import type { Person } from "./team.ts";
import { STATUS_WORD, VERDICT_WORD, type Build } from "./workshop.ts";

export const COLUMNS = ["active", "progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_WORD: Record<Column, string> = { active: "Active", progress: "In progress", review: "Review", done: "Done" };
export const COLUMN_EMPTY: Record<Column, string> = {
  active: "Tasks nobody has started, and finds you adopted that nobody has built yet, appear here.",
  progress: "Workers, masters and builds that are working right now appear here.",
  review: "Plans to approve, patches to look at and runs that need you appear here.",
  done: "Finished runs and builds appear here.",
};
export const DONE_LIMIT = 20;

/** Where a card leads: an agent's panel in the office, or a find's own page. */
export type Target = { agent: string } | { find: string };
/** `own` is set on a card made from one of the owner's tasks: it can be given to a person, started, finished or removed. `person` is who the card is for, on every kind of card: null when nobody. */
export type Task = { id: string; column: Column; title: string; who: string; text: string; chip: string; at: number; target: Target | null; person: Person | null; own?: OwnTask; /** The person it is given to, as "Name, Role", or null. */ assignee?: string | null; /** A worker is on it right now (planning or working), so it cannot be started again. */ running?: boolean };

const short = (text: string, max = 100) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("") + "…";
};
const time = (iso: string) => (Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0);

function agentTask(a: Agent, own: ReadonlySet<string>, team: ReadonlyMap<string, Person>): Task | null {
  if (a.kind === "subagent" || a.status === "detached") return null;
  if (a.taskId && own.has(a.id)) return null; // the owner's task card stands for it
  if (a.workshop && !(a.phase === "planning" && a.plan?.status === "pending")) return null; // the build's card stands for it
  const base = { id: `agent-${a.id}`, title: a.name, who: a.role === "master" ? "Master" : a.role === "worker" ? "Worker" : "Session", at: time(a.updatedAt), target: { agent: a.id }, person: (a.personId ? team.get(a.personId) : undefined) ?? null };
  const text = short(a.currentTask ?? a.activity ?? a.note ?? "");
  if (a.phase === "planning" && a.plan?.status === "pending") return { ...base, column: "review", text: short(`Plan to approve: ${a.plan.goal}`), chip: "Plan waits for you" };
  if (a.status === "error") return { ...base, column: "review", text: short(a.note ?? a.activity ?? "Open it to see what went wrong"), chip: "Failed" };
  if (a.status === "waiting") return { ...base, column: "review", text: short(a.note ?? "Open it to see why"), chip: "Waiting" };
  if (a.status === "working") return { ...base, column: "progress", text, chip: a.phase === "planning" ? "Planning" : "Working" };
  return { ...base, column: "done", text, chip: a.status === "stopped" ? "Stopped" : "Finished" };
}

/** A card for one of the owner's tasks. Its column follows the worker on it: none is Active, planning or working is In progress, anything that needs or waits for the owner is Review, and the owner's own "done" is Done. */
function ownTask(t: OwnTask, agents: ReadonlyMap<string, Agent>, team: ReadonlyMap<string, Person>): Task {
  const p = t.assignee ? team.get(t.assignee) : undefined;
  const a = t.agentId ? agents.get(t.agentId) : undefined;
  const base = { id: `own-${t.id}`, title: t.title, who: p ? `${p.name}, ${p.role}` : "Nobody yet", at: t.createdAt, target: a ? { agent: a.id } : null, person: p ?? null, own: t, assignee: p ? `${p.name}, ${p.role}` : null, running: false };
  // An agent's suggestion is shown in full: the owner reads all of it before deciding, because it can later become a worker's task.
  const text = t.suggestedBy !== undefined ? t.details : short(t.details);
  if (t.done) return { ...base, column: "done", text, chip: "Done" };
  if (t.suggestedBy !== undefined) return { ...base, column: "active", text, chip: `Suggested by ${t.suggestedBy}` };
  if (!a) return { ...base, column: "active", text, chip: p ? "To do" : "Not given out" };
  if (a.status === "detached") return { ...base, column: "review", text: "The server restarted while the worker was on it. Resume it from the office, or start the task again.", chip: "Detached" };
  if (a.phase === "planning" && a.plan?.status === "pending") return { ...base, column: "review", text: short(`Plan to approve: ${a.plan.goal}`), chip: "Plan waits for you", running: true };
  if (a.status === "error") return { ...base, column: "review", text: short(a.note ?? "Open it to see what went wrong"), chip: "Failed" };
  if (a.status === "waiting") return { ...base, column: "review", text: short(a.note ?? "Open it to see why"), chip: "Waiting", running: true };
  if (a.status === "working" || (a.phase === "planning" && a.status !== "stopped" && a.status !== "done")) return { ...base, column: "progress", text: short(a.currentTask ?? a.activity ?? text), chip: a.phase === "planning" ? "Planning" : "Working", running: true };
  return { ...base, column: "review", text: "The worker is done. Look at the result, then mark the task done.", chip: a.status === "stopped" ? "Stopped" : "Finished" };
}

function buildTask(b: Build): Task {
  const base = { id: `build-${b.id}`, title: b.title, who: "Workshop", at: b.createdAt, target: { find: b.finding }, person: null };
  const round = (b.round ?? 1) > 1 ? ` (round ${b.round})` : "";
  if (b.status === "building") return { ...base, column: "progress", text: b.evalRun && !b.evalRun.failed ? `Eval running: ${b.evalRun.done} of ${b.evalRun.total}` : `Building the change${round}`, chip: "Building" };
  if (b.status === "ready") return { ...base, column: "review", text: b.eval ? `Eval: ${VERDICT_WORD[b.eval.verdict]}. ${b.changed} files changed${round}` : `${b.changed} files changed${round}, no eval yet`, chip: STATUS_WORD.ready };
  if (b.status === "error") return { ...base, column: "review", text: "The build failed. Open the find to see why.", chip: STATUS_WORD.error };
  return { ...base, column: "done", text: b.status === "no-changes" ? "The master changed nothing." : "The patch was too large to keep.", chip: STATUS_WORD[b.status] };
}

/** Every card, sorted into columns; the newest first in each, and only the newest few in Done. */
export function tasksOf(agents: readonly Agent[], builds: readonly Build[], findings: readonly Finding[], own: readonly OwnTask[] = [], team: readonly Person[] = []): Record<Column, Task[]> {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const personById = new Map(team.map((p) => [p.id, p]));
  const linkedAgents = new Set(own.flatMap((t) => (t.agentId ? [t.agentId] : [])));
  const built = new Set(builds.map((b) => b.finding));
  const adopted: Task[] = findings
    .filter((f) => f.status === "adopt" && !built.has(f.id))
    .map((f) => ({ id: `find-${f.id}`, column: "active", title: f.title, who: "Research", text: short(f.why), chip: "Adopted", at: time(f.date), target: { find: f.id }, person: null }));
  const all = [...own.map((t) => ownTask(t, agentById, personById)), ...adopted, ...builds.map(buildTask), ...agents.map((a) => agentTask(a, linkedAgents, personById)).filter((t): t is Task => t !== null)];
  const columns: Record<Column, Task[]> = { active: [], progress: [], review: [], done: [] };
  for (const t of all.sort((x, y) => y.at - x.at || x.id.localeCompare(y.id))) columns[t.column].push(t);
  columns.done = columns.done.slice(0, DONE_LIMIT);
  return columns;
}
