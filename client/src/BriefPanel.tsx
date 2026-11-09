import { Pencil } from "lucide-react";
import { useId, useState } from "react";
import { Modal } from "./Modal.tsx";
import { saveBriefEdit, type EvalCase, type Finding } from "./research.ts";

/** The progress strip: where a find is between research and a patch. */
export function Stepper({ stages }: { stages: { id: string; label: string; state: "done" | "current" | "todo" }[] }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {stages.map((s) => (
        <li key={s.id} className={`step step-${s.state}`} {...(s.state === "current" ? { "aria-current": "step" as const } : {})}>
          <span className="step-mark" aria-hidden="true">
            {s.state === "done" ? "✓" : ""}
          </span>
          {s.label}
          <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "current" ? " (next)" : " (not yet)"}</span>
        </li>
      ))}
    </ol>
  );
}

const toLines = (a: string[]) => a.join("\n");
const fromLines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);

/** The brief for the implementor: shown as text, and the owner can correct it before anything is built. */
export function BriefPanel({ f, demo, onSaved }: { f: Finding; demo: boolean; onSaved: () => void }) {
  const id = useId();
  const brief = f.brief;
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [files, setFiles] = useState("");
  const [criteria, setCriteria] = useState("");
  const [cases, setCases] = useState<{ prompt: string; assertions: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!brief) return null;

  const start = () => {
    setGoal(brief.goal);
    setFiles(brief.files);
    setCriteria(brief.criteria);
    setCases(brief.cases.map((c) => ({ prompt: c.prompt, assertions: toLines(c.assertions) })));
    setError("");
    setOpen(true);
  };

  const save = async () => {
    const edit = { goal: goal.trim(), files: files.trim(), criteria: criteria.trim(), cases: cases.map((c): EvalCase => ({ prompt: c.prompt.trim(), assertions: fromLines(c.assertions) })) };
    if (demo) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const result = await saveBriefEdit(f.id, edit);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    onSaved();
  };

  const setCase = (i: number, patch: Partial<{ prompt: string; assertions: string }>) => setCases((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <section className="item-body" aria-label="Brief for the implementor">
      <div className="section-row">
        <h2 className="catalog-section">Brief for the implementor</h2>
        <button type="button" className="add-btn" onClick={start}>
          <Pencil size={16} strokeWidth={1.75} aria-hidden="true" /> Edit the brief
        </button>
      </div>
      <p className="panel-note">
        Written {brief.date} by {brief.written_by}. The Workshop master gets this, and the test requests below are what the skill eval will run with and without the change.
      </p>
      <dl className="item-facts">
        <dt>Goal</dt>
        <dd>{brief.goal}</dd>
        <dt>Files</dt>
        <dd>{brief.files}</dd>
        <dt>It works when</dt>
        <dd>{brief.criteria}</dd>
      </dl>
      <ol className="eval-cases">
        {brief.cases.map((c, i) => (
          <li key={i}>
            <strong>Test request {i + 1}:</strong> {c.prompt}
            <ul>
              {c.assertions.map((a, j) => (
                <li key={j}>{a}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Edit the brief">
        <label htmlFor={`${id}-goal`}>Goal (one line)</label>
        <input id={`${id}-goal`} value={goal} maxLength={300} onChange={(e) => setGoal(e.target.value)} />
        <label htmlFor={`${id}-files`}>Files that change (one line)</label>
        <input id={`${id}-files`} value={files} maxLength={300} onChange={(e) => setFiles(e.target.value)} />
        <label htmlFor={`${id}-criteria`}>It works when (one line)</label>
        <input id={`${id}-criteria`} value={criteria} maxLength={400} onChange={(e) => setCriteria(e.target.value)} />
        {cases.map((c, i) => (
          <fieldset key={i} className="case-box">
            <legend>Test request {i + 1}</legend>
            <label htmlFor={`${id}-p${i}`}>Request</label>
            <input id={`${id}-p${i}`} value={c.prompt} maxLength={400} onChange={(e) => setCase(i, { prompt: e.target.value })} />
            <label htmlFor={`${id}-a${i}`}>Checks the answer must pass (one per line, 1 to 5)</label>
            <textarea id={`${id}-a${i}`} rows={3} value={c.assertions} onChange={(e) => setCase(i, { assertions: e.target.value })} />
          </fieldset>
        ))}
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </Modal>
    </section>
  );
}
