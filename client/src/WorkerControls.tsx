import { useId, useState, type FormEvent } from "react";
import type { Agent } from "../../shared/events.ts";
import { assignTask, resumeAgent, stopAgent, type ActionResult } from "./api.ts";
import { canStop } from "./AgentList.tsx";

export const DEFAULT_RESUME_MESSAGE = "Continue where you left off.";

/** A worker that is no longer running but can be resumed or dismissed. */
export const canResume = (agent: Agent) => agent.origin === "managed" && (agent.status === "stopped" || agent.status === "error" || agent.status === "detached");

/**
 * What can be done with a worker started here: give a running one a task, or resume or dismiss an ended one.
 * `off` is the reason the controls are switched off, or null.
 */
export function WorkerControls({ agent, off }: { agent: Agent; off: string | null }) {
  const running = canStop(agent);
  const [text, setText] = useState(running ? "" : DEFAULT_RESUME_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const textId = useId();
  if (!running && !canResume(agent)) return null;

  async function run(action: () => Promise<ActionResult>, done: string, onOk?: () => void) {
    setBusy(true);
    setMessage("");
    const result = await action();
    setBusy(false);
    setMessage(result.ok ? done : result.message);
    if (result.ok) onOk?.();
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => (running ? assignTask(agent.id, text) : resumeAgent(agent.id, text)), running ? "Task sent." : "Resuming…", () => running && setText(""));
  };

  return (
    <form className="start-form worker-controls" onSubmit={submit}>
      <label htmlFor={textId}>{running ? "Give a task" : "Message to resume with"}</label>
      <textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} required maxLength={10000} rows={3} />
      <div className="app-actions">
        <button type="submit" disabled={busy || Boolean(off)} title={off ?? undefined}>
          {running ? "Send task" : "Resume"}
        </button>
        {!running && (
          <button type="button" disabled={busy || Boolean(off)} title={off ?? undefined} onClick={() => void run(() => stopAgent(agent.id), "Dismissed.")}>
            Dismiss
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className="form-message">
        {off ?? message}
      </p>
    </form>
  );
}
