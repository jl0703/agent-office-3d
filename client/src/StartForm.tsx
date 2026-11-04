import { Plus } from "lucide-react";
import { forwardRef, useId, useState, type FormEvent } from "react";
import { startMaster, startWorker } from "./api.ts";

type Kind = "worker" | "master";

const COPY: Record<Kind, { summary: string; note: string; label: string; button: string; done: string }> = {
  worker: {
    summary: "Start a worker",
    note: "A worker can read, search, edit and write files in its folder and search the web. It cannot run commands.",
    label: "What should it do?",
    button: "Start worker",
    done: "Worker started.",
  },
  master: {
    summary: "Start a master",
    note: "A master splits a goal into tasks and runs up to five workers of its own, inside this folder, then collects their results. It has the same limits as a worker and can only manage the workers it started.",
    label: "Goal for the master",
    button: "Start master",
    done: "Master started.",
  },
};

/** The form that starts a worker or a master. `off` is the reason it is switched off, or null. */
export const StartForm = forwardRef<HTMLDetailsElement, { off: string | null }>(function StartForm({ off }, ref) {
  const [kind, setKind] = useState<Kind>("worker");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const folderId = useId();
  const promptId = useId();
  const copy = COPY[kind];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const result = await (kind === "master" ? startMaster(cwd.trim(), prompt) : startWorker(cwd.trim(), prompt));
    setBusy(false);
    if (result.ok) {
      setPrompt("");
      setMessage(COPY[kind].done);
    } else {
      setMessage(result.message);
    }
  }

  return (
    <details className="start" ref={ref}>
      <summary>
        <Plus size={20} strokeWidth={1.75} aria-hidden="true" /> Start a worker or master
      </summary>
      <form id="start-form" onSubmit={(event) => void submit(event)} className="start-form">
        <fieldset className="kind">
          <legend>What to start</legend>
          {(["worker", "master"] as const).map((k) => (
            <label key={k} className="kind-option">
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {COPY[k].summary.replace("Start a ", "").replace(/^./, (c) => c.toUpperCase())}
            </label>
          ))}
        </fieldset>
        <p className="note">{copy.note}</p>
        <label htmlFor={folderId}>Folder (full path)</label>
        <input id={folderId} value={cwd} onChange={(e) => setCwd(e.target.value)} required maxLength={1000} placeholder="C:\path\to\project" />
        <label htmlFor={promptId}>{copy.label}</label>
        <textarea id={promptId} value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={10000} rows={4} />
        <button type="submit" disabled={busy || Boolean(off)}>
          {busy ? "Starting…" : copy.button}
        </button>
        <p role="status" aria-live="polite" className="form-message">
          {off ?? message}
        </p>
      </form>
    </details>
  );
});
