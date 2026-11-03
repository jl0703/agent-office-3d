import type { Agent, ServerEvent } from "../../shared/events.ts";

export type AgentsState = { agents: Record<string, Agent> };
export type TreeNode = { agent: Agent; children: TreeNode[] };

export const initialState: AgentsState = { agents: {} };

export function applyEvent(state: AgentsState, event: ServerEvent): AgentsState {
  switch (event.type) {
    case "snapshot":
      return { agents: Object.fromEntries(event.agents.map((a) => [a.id, a])) };
    case "agent.spawned":
    case "agent.updated":
      return { agents: { ...state.agents, [event.agent.id]: event.agent } };
    case "agent.status": {
      const current = state.agents[event.id];
      if (!current) return state;
      return { agents: { ...state.agents, [event.id]: { ...current, status: event.status } } };
    }
    case "agent.activity": {
      const current = state.agents[event.id];
      if (!current) return state;
      const next = { ...current, tool: event.tool, activity: event.summary, updatedAt: event.ts };
      return { agents: { ...state.agents, [event.id]: next } };
    }
    case "agent.removed": {
      if (!(event.id in state.agents)) return state;
      const rest = { ...state.agents };
      delete rest[event.id];
      return { agents: rest };
    }
  }
}

// Sorted by project and name, not by status, so rows do not jump around as agents go idle.
const byName = (a: Agent, b: Agent) =>
  a.project.localeCompare(b.project) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export function buildTree(state: AgentsState): TreeNode[] {
  const all = Object.values(state.agents).sort(byName);
  const childrenOf = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of all) {
    const parent = agent.parentId;
    if (parent !== null && parent !== agent.id && parent in state.agents) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), agent]);
    } else {
      roots.push(agent);
    }
  }

  const seen = new Set<string>();
  const build = (agent: Agent): TreeNode => {
    seen.add(agent.id);
    const children = (childrenOf.get(agent.id) ?? []).filter((c) => !seen.has(c.id)).map(build);
    return { agent, children };
  };
  const tree = roots.map(build);
  // Agents that point at each other have no root; show them at the top level instead of losing them.
  for (const agent of all) if (!seen.has(agent.id)) tree.push(build(agent));
  return tree;
}
