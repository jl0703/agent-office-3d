import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { addSkill, removeSkill, SKILL_NAME } from "./setup.ts";

type Mode = "paste" | "folder";
type Pending = { kind: "add"; name: string; content?: string; source?: string } | { kind: "remove"; name: string };

const TEMPLATE = (name: string) => `---\nname: ${name || "my-skill"}\ndescription: One line saying when to use it\n---\n\nWhat the skill tells Claude to do.\n`;

/** Add and remove skills. Every change shows what will happen and waits for a click on Confirm. */
export function SkillManager({ demo, off, onChanged, pendingRemove, onAskRemove }: {
  demo: boolean;
  off: boolean;
  onChanged: () => void;
  pendingRemove: string | null;
  onAskRemove: (name: string | null) => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("paste");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const nameOk = SKILL_NAME.test(name);
  const ready = nameOk && (mode === "paste" ? content.trim() !== "" : source.trim() !== "");

  const review = () => {
    setMessage("");
    setPending({ kind: "add", name, ...(mode === "paste" ? { content } : { source: source.trim() }) });
  };

  const run = async (p: Pending) => {
    setBusy(true);
    const result = demo ? ({ ok: true } as const) : p.kind === "remove" ? await removeSkill(p.name) : await addSkill(p.content !== undefined ? { name: p.name, content: p.content } : { name: p.name, source: p.source ?? "" });
    setBusy(false);
    setPending(null);
    onAskRemove(null);
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

  return (
    <div className="skill-manager">
      <details>
        <summary>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add a skill
        </summary>
        <div className="chips" role="group" aria-label="How to add it">
          <button type="button" className="chip-filter" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
            Paste SKILL.md
          </button>
          <button type="button" className="chip-filter" aria-pressed={mode === "folder"} onClick={() => setMode("folder")}>
            Copy a folder
          </button>
        </div>
        <label htmlFor={`${id}-name`}>Skill name</label>
        <input id={`${id}-name`} value={name} maxLength={60} aria-invalid={name !== "" && !nameOk} aria-describedby={`${id}-name-hint`} onChange={(e) => setName(e.target.value)} placeholder="my-skill" />
        <p id={`${id}-name-hint`} className="panel-note">
          Lowercase letters, digits and hyphens. An existing skill is never replaced.
        </p>
        {mode === "paste" ? (
          <>
            <label htmlFor={`${id}-content`}>SKILL.md text</label>
            <textarea id={`${id}-content`} rows={8} maxLength={100_000} value={content} onChange={(e) => setContent(e.target.value)} placeholder={TEMPLATE(name)} />
          </>
        ) : (
          <>
            <label htmlFor={`${id}-source`}>Folder to copy (full path, with a SKILL.md inside)</label>
            <input id={`${id}-source`} value={source} maxLength={1000} onChange={(e) => setSource(e.target.value)} placeholder="C:\path\to\skill" />
          </>
        )}
        <button type="button" disabled={!ready || off || busy} title={off ? "Not available right now" : undefined} onClick={review}>
          Review
        </button>
      </details>

      {(pending ?? (pendingRemove ? ({ kind: "remove", name: pendingRemove } as const) : null)) && (
        <div className="confirm-box" role="alertdialog" aria-labelledby={`${id}-confirm`} aria-describedby={`${id}-confirm-text`}>
          <strong id={`${id}-confirm`}>Change your Claude setup?</strong>
          {(() => {
            const p = pending ?? { kind: "remove" as const, name: pendingRemove ?? "" };
            return (
              <>
                <p id={`${id}-confirm-text`} className="panel-note">
                  {p.kind === "remove"
                    ? `Move the skill "${p.name}" from your skills folder to the trash folder. You can move it back by hand.`
                    : `Create the skill "${p.name}" in your skills folder${p.content !== undefined ? ` from the pasted text (${new Blob([p.content]).size} bytes)` : ` by copying ${p.source}`}. Claude Code will load it in new sessions. Read it first if you did not write it.`}
                </p>
                <div className="board-actions">
                  <button type="button" disabled={busy} onClick={() => void run(p)}>
                    {busy ? "Working…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPending(null);
                      onAskRemove(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      )}
      <p role="status" aria-live="polite" className="form-message">
        {message}
      </p>
    </div>
  );
}

/** The small remove button on a skill row (only for skills added from the sidebar). */
export function RemoveButton({ name, onAsk, disabled }: { name: string; onAsk: (name: string) => void; disabled: boolean }) {
  return (
    <button type="button" className="icon-btn tip" aria-label={`Remove ${name}`} data-tip="Move to trash" disabled={disabled} onClick={() => onAsk(name)}>
      <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
