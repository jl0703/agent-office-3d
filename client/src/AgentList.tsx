import type { AgentStatus } from "../../shared/events.ts";
import type { TreeNode } from "./agents.ts";

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  done: "Done",
};

function Row({ node }: { node: TreeNode }) {
  const { agent, children } = node;
  return (
    <li className="agent">
      <p className="agent-head">
        <strong>{agent.name}</strong>
        <span className="project">{agent.project}</span>
        <span className={`status status-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
      </p>
      {agent.currentTask && <p className="task">{agent.currentTask}</p>}
      <p className="activity">{agent.activity ?? "No tool used yet"}</p>
      {children.length > 0 && (
        <ul aria-label={`Subagents of ${agent.name}`}>
          {children.map((child) => (
            <Row key={child.agent.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function AgentList({ tree }: { tree: TreeNode[] }) {
  if (tree.length === 0) {
    return <p>No active Claude Code sessions. A session appears here when it writes to its log.</p>;
  }
  return (
    <ul aria-label="Claude Code sessions" className="agents">
      {tree.map((node) => (
        <Row key={node.agent.id} node={node} />
      ))}
    </ul>
  );
}
