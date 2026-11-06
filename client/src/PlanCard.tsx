import { useEffect, useState } from "react";
import type { Agent, Plan } from "../../shared/events.ts";
import { decidePlan } from "./api.ts";

const STATUS_WORD: Record<Plan["status"], string> = { pending: "Waiting for your answer", approved: "Approved", changes: "Changes requested", rejected: "Rejected" };

/** A master's plan: what it intends to do, and the owner's three answers. Nothing starts before approval. */
export function PlanCard({ agent, plan, off }: { agent: Agent; plan: Plan; off: string | null }) {
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNote("");
    setMessage("");
  }, [agent.id, plan.goal, plan.status]);
  const pending = plan.status === "pending";

  const answer = async (decision: "approve" | "changes" | "reject") => {
    setBusy(true);
    const result = await decidePlan(agent.id, decision, note.trim() || undefined);
    setBusy(false);
    setMessage(result.ok ? "" : result.message);
  };

  return (
    <section className="plan-card" aria-label="Plan">
      <h3>
        Plan <span className={`plan-status plan-${plan.status}`}>{plan.auto && plan.status === "approved" ? "Approved automatically by your rule" : STATUS_WORD[plan.status]}</span>
      </h3>
      <p>{plan.goal}</p>
      <ol>
        {plan.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <dl className="panel-facts">
        <dt>Workers</dt>
        <dd>{plan.workers}</dd>
        <dt>Estimated cost</dt>
        <dd>${plan.costUsd.toFixed(2)}</dd>
        <dt>Files</dt>
        <dd>{plan.files.length ? plan.files.join(", ") : "None named"}</dd>
        <dt>Risks</dt>
        <dd>{plan.risks || "None named"}</dd>
        <dt>How to undo</dt>
        <dd>{plan.undo || "Not said"}</dd>
        {plan.note && (
          <>
            <dt>Your note</dt>
            <dd>{plan.note}</dd>
          </>
        )}
      </dl>
      {pending && (
        <>
          <label className="finding-note">
            Note for the master (needed only for changes)
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value.replace(/[\r\n]/g, " "))} />
          </label>
          <p id={`${agent.id}-plan-hint`} className="panel-note">
            {off ?? "Asking for changes needs a note saying what to change."}
          </p>
          <div className="decisions">
            <button type="button" disabled={busy || Boolean(off)} title={off ?? undefined} onClick={() => void answer("approve")}>
              Approve
            </button>
            <button type="button" disabled={busy || Boolean(off) || !note.trim()} aria-describedby={`${agent.id}-plan-hint`} title={off ?? undefined} onClick={() => void answer("changes")}>
              Ask for changes
            </button>
            <button type="button" disabled={busy || Boolean(off)} title={off ?? undefined} onClick={() => void answer("reject")}>
              Reject
            </button>
          </div>
        </>
      )}
      <p role="status" aria-live="polite" className="form-message">
        {message}
      </p>
    </section>
  );
}
