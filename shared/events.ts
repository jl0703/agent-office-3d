// Types shared by the server and the browser. Type-only: nothing here runs.

export type AgentStatus = "working" | "idle" | "done" | "stopped" | "error";

export type Agent = {
  id: string;
  kind: "session" | "subagent";
  /** Seen through its log file (view-only), or started by this app (controllable). */
  origin: "observed" | "managed";
  role: "solo" | "worker";
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
  updatedAt: string;
};

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
