import type { Agent, AgentStatus } from "../../shared/events.ts";
import type { TreeNode } from "./agents.ts";

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  done: "Done",
  stopped: "Stopped",
  error: "Error",
  waiting: "Waiting",
  detached: "Detached",
};

type Controls = {
  stopping: ReadonlySet<string>;
  onStop: (id: string) => void;
  /** Demo agents cannot be stopped. */
  readOnly?: boolean;
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
};

/** A worker started here that has not ended yet. */
export const canStop = (agent: Agent) => agent.origin === "managed" && (agent.status === "working" || agent.status === "idle");

function Row({ node, controls }: { node: TreeNode; controls: Controls }) {
  const { agent, children } = node;
  return (
    <li className={`agent${controls.selectedId === agent.id ? " agent-selected" : ""}${controls.hoveredId === agent.id ? " agent-hover" : ""}`}>
      <p className="agent-head">
        <button
          type="button"
          className="row-name"
          aria-pressed={controls.selectedId === agent.id}
          onClick={() => controls.onSelect?.(agent.id)}
          onMouseEnter={() => controls.onHover?.(agent.id)}
          onMouseLeave={() => controls.onHover?.(null)}
          onFocus={() => controls.onHover?.(agent.id)}
          onBlur={() => controls.onHover?.(null)}
        >
          {agent.name}
        </button>
        <span className="project">{agent.project}</span>
        {agent.origin === "managed" && <span className="origin">started here</span>}
        <span className={`status status-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
        {canStop(agent) && !controls.readOnly && (
          <button
            type="button"
            className="stop"
            aria-label={`Stop ${agent.name}`}
            disabled={controls.stopping.has(agent.id)}
            onClick={() => controls.onStop(agent.id)}
          >
            {controls.stopping.has(agent.id) ? "Stopping…" : "Stop"}
          </button>
        )}
      </p>
      {agent.currentTask && <p className="task">{agent.currentTask}</p>}
      <p className="activity">{agent.activity ?? "No tool used yet"}</p>
      {children.length > 0 && (
        <ul aria-label={`Subagents of ${agent.name}`}>
          {children.map((child) => (
            <Row key={child.agent.id} node={child} controls={controls} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function AgentList({ tree, ...controls }: { tree: TreeNode[] } & Controls) {
  if (tree.length === 0) {
    return <p>No active Claude Code sessions. A session appears here when it writes to its log.</p>;
  }
  return (
    <ul aria-label="Claude Code sessions" className="agents">
      {tree.map((node) => (
        <Row key={node.agent.id} node={node} controls={controls} />
      ))}
    </ul>
  );
}
