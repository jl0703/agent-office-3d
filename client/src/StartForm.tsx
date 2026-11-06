import { Plus } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { loadRecent, remember } from "./recent.ts";
import { startMaster, startResearch, startWorker } from "./api.ts";

type Kind = "worker" | "master" | "research";

const COPY: Record<Kind, { summary: string; note: string; label: string; button: string; done: string }> = {
  worker: {
    summary: "Start a worker",
    note: "A worker can read, search, edit and write files in its folder and search the web. It cannot run commands.",
    label: "What should it do?",
    button: "Start worker",
    done: "Worker started.",
  },
  research: {
    summary: "Start a research team",
    note: "A lead and up to three scouts search GitHub (real star counts, licences, activity), skills and MCP servers, and write one report with recommendations for this workspace into the research folder. Nothing is installed.",
    label: "What should the team find out?",
    button: "Start research",
    done: "Research team started.",
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
export type StartPreset = { prompt: string; nonce: number };

export const StartForm = forwardRef<HTMLDetailsElement, { off: string | null; preset?: StartPreset | null }>(function StartForm({ off, preset }, ref) {
  const [kind, setKind] = useState<Kind>("worker");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [recent, setRecent] = useState(loadRecent);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const folderId = useId();
  const promptId = useId();
  const recentId = useId();
  const listId = useId();
  const copy = COPY[kind];
  const innerRef = useRef<HTMLDetailsElement | null>(null);

  // A finding handed to a master fills the form (as a master's goal) and opens it; the person still has to press Start.
  useEffect(() => {
    if (!preset) return;
    setKind("master");
    setPrompt(preset.prompt);
    if (innerRef.current) innerRef.current.open = true;
  }, [preset?.nonce]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const result = await (kind === "research" ? startResearch(prompt) : kind === "master" ? startMaster(cwd.trim(), prompt) : startWorker(cwd.trim(), prompt));
    setBusy(false);
    if (result.ok) {
      setRecent(remember(kind === "research" ? "" : cwd, prompt));
      setPrompt("");
      setMessage(COPY[kind].done);
    } else {
      setMessage(result.message);
    }
  }

  return (
    <details
      className="start"
      ref={(el) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
    >
      <summary>
        <Plus size={20} strokeWidth={1.75} aria-hidden="true" /> Start a worker or master
      </summary>
      <form id="start-form" onSubmit={(event) => void submit(event)} className="start-form">
        <fieldset className="kind">
          <legend>What to start</legend>
          {(["worker", "master", "research"] as const).map((k) => (
            <label key={k} className="kind-option">
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {COPY[k].summary.replace("Start a ", "").replace(/^./, (c) => c.toUpperCase())}
            </label>
          ))}
        </fieldset>
        <p className="note">{copy.note}</p>
        {kind !== "research" && (
          <>
            <label htmlFor={folderId}>Folder (full path)</label>
            <input id={folderId} value={cwd} onChange={(e) => setCwd(e.target.value)} required maxLength={1000} placeholder="C:\path\to\project" list={listId} />
            <datalist id={listId}>
              {recent.folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </>
        )}
        {recent.prompts.length > 0 && (
          <>
            <label htmlFor={recentId}>Reuse an earlier prompt</label>
            <select id={recentId} value="" onChange={(e) => e.target.value && setPrompt(e.target.value)}>
              <option value="">Choose one…</option>
              {recent.prompts.map((p) => (
                <option key={p} value={p}>
                  {p.length > 80 ? `${p.slice(0, 80)}…` : p}
                </option>
              ))}
            </select>
          </>
        )}
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
