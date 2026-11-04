import type { Agent } from "../../../shared/events.ts";

const MAX_DEPTH = 6;

/** The top of the chain of parents that are present in the list. An agent whose parent is gone is its own top. */
export function rootOf(agent: Agent, lookup: ReadonlyMap<string, Agent>): Agent {
  let cur = agent;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = cur.parentId === null ? undefined : lookup.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

/**
 * A number from 0 to 5 for each agent: the same for a session and all its subagents, and different
 * for different sessions until the six run out. Stable while the desks stay the same.
 */
export function familyIndexes(agents: readonly Agent[], colors = 6): Map<string, number> {
  const lookup = new Map(agents.map((a) => [a.id, a]));
  const roots = [...new Set(agents.map((a) => rootOf(a, lookup).id))].sort((x, y) => (lookup.get(x)?.desk ?? 0) - (lookup.get(y)?.desk ?? 0));
  const rank = new Map(roots.map((id, i) => [id, i % colors]));
  return new Map(agents.map((a) => [a.id, rank.get(rootOf(a, lookup).id) ?? 0]));
}
