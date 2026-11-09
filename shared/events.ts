// Types shared by the server and the browser. Type-only: nothing here runs.

// "waiting" (usage limit reached) and "detached" (found again after a restart, not running) come from managed workers.
export type AgentStatus = "working" | "idle" | "done" | "stopped" | "error" | "waiting" | "detached";

/** A master's plan. The owner decides on it before any worker starts. */
export type Plan = {
  goal: string;
  steps: string[];
  files: string[];
  workers: number;
  costUsd: number;
  risks: string;
  undo: string;
  status: "pending" | "approved" | "changes" | "rejected";
  /** The owner's note from the last decision, at most 500 characters. */
  note?: string;
  /** Approved by the owner's auto-approve rule, not by a click. */
  auto?: boolean;
};

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
  /** Estimated usage of this session across resumes, in US dollars rounded to cents. Managed agents only. */
  usd?: number;
  /** Masters only. A master starts in "planning" (read-only, no workers) until its plan is approved. */
  phase?: "planning" | "executing";
  /** Masters only. The latest submitted plan, or null before the first one. */
  plan?: Plan | null;
  /** The person (from the team) this session works as, and the task it was started for. Set by the server when a task is started. */
  personId?: string;
  taskId?: string;
  /** A Workshop build's master: the build has its own card. */
  workshop?: true;
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
