// Searching and filtering the session list. Pure functions.
import type { Agent, AgentStatus } from "../../shared/events.ts";
import type { TreeNode } from "./agents.ts";

export type Filter = { query: string; statuses: ReadonlySet<AgentStatus> };

export const noFilter: Filter = { query: "", statuses: new Set() };

export const isFiltering = (f: Filter) => f.query.trim() !== "" || f.statuses.size > 0;

/** Does the agent match the words typed (all of them, anywhere in its name, project, task or latest activity) and the chosen statuses? */
export function matches(agent: Agent, filter: Filter): boolean {
  if (filter.statuses.size > 0 && !filter.statuses.has(agent.status)) return false;
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [agent.name, agent.project, agent.currentTask ?? "", agent.activity ?? "", agent.tool ?? ""].join("\n").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Keeps the nodes that match, and the parents of matches so a worker is still seen under its master. */
export function filterTree(nodes: readonly TreeNode[], filter: Filter): TreeNode[] {
  if (!isFiltering(filter)) return [...nodes];
  const out: TreeNode[] = [];
  for (const node of nodes) {
    const children = filterTree(node.children, filter);
    if (children.length > 0 || matches(node.agent, filter)) out.push({ agent: node.agent, children });
  }
  return out;
}

/**
 * How many agents have each status, in the usual order: the statuses that occur, plus any that are
 * switched on in the filter (with a count of 0), so a chosen chip never vanishes while it still filters.
 */
export function countByStatus(agents: readonly Agent[], order: readonly AgentStatus[], chosen: ReadonlySet<AgentStatus> = new Set()): { status: AgentStatus; count: number }[] {
  const counts = new Map<AgentStatus, number>();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  return order.filter((s) => counts.has(s) || chosen.has(s)).map((s) => ({ status: s, count: counts.get(s) ?? 0 }));
}

/** The next or previous element in a list, wrapping at the ends; null when the list is empty. */
export function step<T>(items: readonly T[], current: T | undefined, by: 1 | -1): T | null {
  if (items.length === 0) return null;
  const at = current === undefined ? -1 : items.indexOf(current);
  if (at === -1) return (by === 1 ? items[0] : items[items.length - 1]) ?? null;
  return items[(at + by + items.length) % items.length] ?? null;
}
