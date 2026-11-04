import { Plus } from "lucide-react";
import { forwardRef, useId, useState, type FormEvent } from "react";
import { startWorker } from "./api.ts";

/** The form that starts a worker. `off` is the reason it is switched off, or null. */
export const StartForm = forwardRef<HTMLDetailsElement, { off: string | null }>(function StartForm({ off }, ref) {
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const folderId = useId();
  const promptId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const result = await startWorker(cwd.trim(), prompt);
    setBusy(false);
    if (result.ok) {
      setPrompt("");
      setMessage("Worker started.");
    } else {
      setMessage(result.message);
    }
  }

  return (
    <details className="start" ref={ref}>
      <summary>
        <Plus size={20} strokeWidth={1.75} aria-hidden="true" /> Start a worker
      </summary>
      <form id="start-form" onSubmit={(event) => void submit(event)} className="start-form">
        <p className="note">
          A worker can read, search, edit and write files in its folder and search the web. It cannot run commands.
        </p>
        <label htmlFor={folderId}>Folder (full path)</label>
        <input id={folderId} value={cwd} onChange={(e) => setCwd(e.target.value)} required maxLength={1000} placeholder="C:\path\to\project" />
        <label htmlFor={promptId}>What should it do?</label>
        <textarea id={promptId} value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={10000} rows={4} />
        <button type="submit" disabled={busy || Boolean(off)}>
          {busy ? "Starting…" : "Start worker"}
        </button>
        <p role="status" aria-live="polite" className="form-message">
          {off ?? message}
        </p>
      </form>
    </details>
  );
});
