import type { Agent, AgentStatus } from "../../shared/events.ts";

const WORD: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  done: "Done",
  stopped: "Stopped",
  error: "Error",
  waiting: "Waiting",
  detached: "Detached",
};

/** A short summary of the selected agent. The workspace shell replaces it with a full panel. */
export function SelectedBar({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  return (
    <section className="selected-bar" aria-label="Selected agent">
      <p>
        <strong>{agent.name}</strong> <span className="project">({agent.project})</span> ·{" "}
        <span className={`status status-${agent.status}`}>{WORD[agent.status]}</span> ·{" "}
        {agent.origin === "managed" ? "started here" : "watched"}
      </p>
      {agent.currentTask && <p className="task">{agent.currentTask}</p>}
      <p className="activity">{agent.activity ?? "No tool used yet"}</p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
