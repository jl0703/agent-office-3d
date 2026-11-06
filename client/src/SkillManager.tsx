import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { addAgent, addSkill, removeAgent, removeSkill, SKILL_NAME } from "./setup.ts";

type Mode = "paste" | "folder";
type Pending = { kind: "add"; name: string; content?: string; source?: string } | { kind: "remove"; name: string };

const TEMPLATE = (name: string) => `---\nname: ${name || "my-skill"}\ndescription: One line saying when to use it\n---\n\nWhat the skill tells Claude to do.\n`;
const AGENT_TEMPLATE = (name: string) => `---\nname: ${name || "my-agent"}\ndescription: One line saying when to use it\ntools: Read, Grep\nmodel: sonnet\n---\n\nWhat the agent does and how.\n`;

/** Add and remove skills or agents. Every change shows what will happen and waits for a click on Confirm. */
export function SkillManager({ demo, off, noun = "skill", showAdd = true, onChanged, pendingRemove, onAskRemove }: {
  demo: boolean;
  off: boolean;
  /** Skills are folders with a SKILL.md; agents are single .md files. */
  noun?: "skill" | "agent";
  /** False on an item's own page, where only the remove confirmation is needed. */
  showAdd?: boolean;
  onChanged: () => void;
  pendingRemove: string | null;
  onAskRemove: (name: string | null) => void;
}) {
  const id = useId();
  const agent = noun === "agent";
  const add = agent ? addAgent : addSkill;
  const take = agent ? removeAgent : removeSkill;
  const [mode, setMode] = useState<Mode>("paste");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLElement | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null);
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const asking = pending !== null || pendingRemove !== null;

  // Asking to remove closes an add review, and a confirm box that opens takes focus so keyboard users land in it.
  useEffect(() => {
    if (pendingRemove) setPending(null);
  }, [pendingRemove]);
  useEffect(() => {
    if (asking) heading.current?.focus();
  }, [asking]);

  const cancel = (p: Pending) => {
    setPending(null);
    onAskRemove(null);
    // Back to the button that asked: Review, or the row's remove button.
    requestAnimationFrame(() => (p.kind === "add" ? reviewButton.current : document.querySelector<HTMLElement>(`[aria-label="Remove ${p.name}"]`))?.focus());
  };

  const nameOk = SKILL_NAME.test(name);
  const ready = nameOk && (mode === "paste" ? content.trim() !== "" : source.trim() !== "");

  const review = () => {
    setMessage("");
    setPending({ kind: "add", name, ...(mode === "paste" ? { content } : { source: source.trim() }) });
  };

  const run = async (p: Pending) => {
    setBusy(true);
    const result = demo ? ({ ok: true } as const) : p.kind === "remove" ? await take(p.name) : await add(p.content !== undefined ? { name: p.name, content: p.content } : { name: p.name, source: p.source ?? "" });
    setBusy(false);
    setPending(null);
    onAskRemove(null);
    // The confirm box and, after a removal, the row are gone: the status line says what happened.
    requestAnimationFrame(() => status.current?.focus());
    if (result.ok) {
      setMessage(demo ? "Demo mode: nothing was changed." : p.kind === "add" ? `Added ${p.name}. New Claude Code sessions will see it.` : `Moved ${p.name} to the trash folder.`);
      if (p.kind === "add" && !demo) {
        setName("");
        setContent("");
        setSource("");
      }
      onChanged();
    } else {
      setMessage(result.message);
    }
  };

  const active: Pending | null = pending ?? (pendingRemove ? { kind: "remove", name: pendingRemove } : null);

  return (
    <div className="skill-manager">
      {showAdd && (
        <details>
          <summary>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> {agent ? "Add an agent" : "Add a skill"}
          </summary>
          <div className="chips" role="group" aria-label="How to add it">
            <button type="button" className="chip-filter" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
              {agent ? "Paste the agent file" : "Paste SKILL.md"}
            </button>
            <button type="button" className="chip-filter" aria-pressed={mode === "folder"} onClick={() => setMode("folder")}>
              {agent ? "Copy a file" : "Copy a folder"}
            </button>
          </div>
          <label htmlFor={`${id}-name`}>{agent ? "Agent name" : "Skill name"}</label>
          <input id={`${id}-name`} value={name} maxLength={60} aria-invalid={name !== "" && !nameOk} aria-describedby={`${id}-name-hint`} onChange={(e) => setName(e.target.value)} placeholder={agent ? "my-agent" : "my-skill"} />
          <p id={`${id}-name-hint`} className="panel-note">
            Lowercase letters, digits and hyphens. An existing {noun} is never replaced.
          </p>
          {mode === "paste" ? (
            <>
              <label htmlFor={`${id}-content`}>{agent ? "Agent file text" : "SKILL.md text"}</label>
              <textarea id={`${id}-content`} rows={8} maxLength={100_000} value={content} onChange={(e) => setContent(e.target.value)} placeholder={agent ? AGENT_TEMPLATE(name) : TEMPLATE(name)} />
            </>
          ) : (
            <>
              <label htmlFor={`${id}-source`}>{agent ? "File to copy (full path of a .md file)" : "Folder to copy (full path, with a SKILL.md inside)"}</label>
              <input id={`${id}-source`} value={source} maxLength={1000} onChange={(e) => setSource(e.target.value)} placeholder={agent ? "C:/path/to/agent.md" : "C:/path/to/skill"} />
            </>
          )}
          <button type="button" disabled={!ready || off || busy} title={off ? "Not available right now" : undefined} ref={reviewButton} onClick={review}>
            Review
          </button>
        </details>
      )}

      {active && (
        <div className="confirm-box" role="alertdialog" aria-labelledby={`${id}-confirm`} aria-describedby={`${id}-confirm-text`}>
          <strong id={`${id}-confirm`} ref={heading} tabIndex={-1}>
            Change your Claude setup?
          </strong>
          <p id={`${id}-confirm-text`} className="panel-note">
            {active.kind === "remove"
              ? `Move the ${noun} "${active.name}" from your ${noun}s folder to the trash folder. You can move it back by hand.`
              : `Create the ${noun} "${active.name}" in your ${noun}s folder${active.content !== undefined ? ` from the pasted text (${new Blob([active.content]).size} bytes)` : ` by copying ${active.source}`}. Claude Code will load it in new sessions. Read it first if you did not write it.`}
          </p>
          <div className="board-actions">
            <button type="button" disabled={busy} onClick={() => void run(active)}>
              {busy ? "Working…" : "Confirm"}
            </button>
            <button type="button" disabled={busy} onClick={() => cancel(active)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="form-message" ref={status} tabIndex={-1}>
        {message}
      </p>
    </div>
  );
}

/** The small remove button on a row (only for items added from this app). */
export function RemoveButton({ name, onAsk, disabled }: { name: string; onAsk: (name: string) => void; disabled: boolean }) {
  return (
    <button type="button" className="icon-btn tip" aria-label={`Remove ${name}`} data-tip="Move to trash" disabled={disabled} onClick={() => onAsk(name)}>
      <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
