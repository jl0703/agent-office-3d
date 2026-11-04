import { useId, useState, type FormEvent } from "react";
import { startWorker } from "./api.ts";

export function StartForm({ disabled = false }: { disabled?: boolean }) {
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
    <form id="start-form" onSubmit={(event) => void submit(event)} className="start-form">
      <h2>Start a worker</h2>
      <p className="note">
        A worker can read, search, edit and write files in its folder and search the web. It cannot run commands.
      </p>
      <label htmlFor={folderId}>Folder (full path)</label>
      <input id={folderId} value={cwd} onChange={(e) => setCwd(e.target.value)} required maxLength={1000} placeholder="C:\path\to\project" />
      <label htmlFor={promptId}>What should it do?</label>
      <textarea id={promptId} value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={10000} rows={4} />
      <button type="submit" disabled={busy || disabled}>
        {busy ? "Starting…" : "Start worker"}
      </button>
      <p role="status" aria-live="polite" className="form-message">
        {disabled ? "Starting workers is switched off in demo mode." : message}
      </p>
    </form>
  );
}
