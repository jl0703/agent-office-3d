// Types shared by the server and the browser. Type-only: nothing here runs.

// "waiting" (usage limit reached) and "detached" (found again after a restart, not running) come from managed workers.
export type AgentStatus = "working" | "idle" | "done" | "stopped" | "error" | "waiting" | "detached";

export type Agent = {
  id: string;
  kind: "session" | "subagent";
  /** Seen through its log file (view-only), or started by this app (controllable). */
  origin: "observed" | "managed";
  role: "solo" | "worker" | "master";
  /** Set for the research team's master and its workers. */
  team?: "research";
  parentId: string | null;
  name: string;
  /** Base name of the working folder, never the full path. */
  project: string;
  status: AgentStatus;
  /** At most 200 characters. */
  currentTask: string | null;
  tool: string | null;
  /** Summary of the latest tool call, at most 200 characters. */
  activity: string | null;
  /** Stable seat in the office: the smallest free number, freed when the agent leaves. */
  desk: number;
  updatedAt: string;
  /** Why the agent is waiting, stopped, or detached. At most 200 characters. */
  note: string | null;
};

/** One tool call in an agent's recent history. */
export type ActivityEntry = { ts: string; tool: string | null; summary: string };

export type ServerEvent =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "agent.spawned"; agent: Agent }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.status"; id: string; status: AgentStatus }
  | { type: "agent.activity"; id: string; tool: string | null; summary: string; ts: string }
  | { type: "agent.removed"; id: string };

export const EVENT_TYPES = [
  "snapshot",
  "agent.spawned",
  "agent.updated",
  "agent.status",
  "agent.activity",
  "agent.removed",
] as const satisfies readonly ServerEvent["type"][];
