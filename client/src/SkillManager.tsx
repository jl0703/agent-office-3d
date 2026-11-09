import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal.tsx";
import { addAgent, addSkill, removeAgent, removeSkill, SKILL_NAME } from "./setup.ts";

type Mode = "paste" | "folder";
type Step = "closed" | "form" | "confirm";

const TEMPLATE = (name: string) => `---\nname: ${name || "my-skill"}\ndescription: One line saying when to use it\n---\n\nWhat the skill tells Claude to do.\n`;
const AGENT_TEMPLATE = (name: string) => `---\nname: ${name || "my-agent"}\ndescription: One line saying when to use it\ntools: Read, Grep\nmodel: sonnet\n---\n\nWhat the agent does and how.\n`;

/** One header value of pasted text, such as tools or model, on one line: only the header counts, and the last one wins. Empty when missing. */
function headerValue(text: string, key: string): string {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const end = lines.indexOf("---", 1);
  if (lines[0]?.trim() !== "---" || end === -1) return "";
  const found = lines.slice(1, end).filter((l) => l.toLowerCase().startsWith(`${key}:`));
  return found.at(-1)?.slice(key.length + 1).trim().slice(0, 120) ?? "";
}

/**
 * Add and remove skills or agents. The add form and every confirmation open in a pop-up window, and nothing changes
 * until Confirm is pressed. Put this next to the list's heading: the "Add" button is what it shows on the page.
 */
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
  const [step, setStep] = useState<Step>("closed");
  const [mode, setMode] = useState<Mode>("paste");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Asking to remove something closes the add window.
  useEffect(() => {
    if (pendingRemove) setStep("closed");
  }, [pendingRemove]);

  const nameOk = SKILL_NAME.test(name);
  const ready = nameOk && (mode === "paste" ? content.trim() !== "" : source.trim() !== "");
  const input = mode === "paste" ? { name, content } : { name, source: source.trim() };

  const run = async (remove: boolean) => {
    setBusy(true);
    setError("");
    const target = pendingRemove ?? name;
    const result = demo ? ({ ok: true } as const) : remove ? await take(target) : await add(input);
    setBusy(false);
    if (!result.ok) return setError(result.message); // the window stays open, with the reason in it
    setStep("closed");
    onAskRemove(null);
    setMessage(demo ? "Demo mode: nothing was changed." : remove ? `Moved ${target} to the trash folder.` : `Added ${target}. New Claude Code sessions will see it.`);
    if (!remove && !demo) {
      setName("");
      setContent("");
      setSource("");
    }
    onChanged();
  };

  const closeAdd = () => {
    setStep("closed");
    setError("");
  };

  return (
    <div className="manager">
      {showAdd && (
        <button type="button" className="add-btn" disabled={off} title={off ? "Not available right now" : undefined} onClick={() => setStep("form")}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> {agent ? "Add an agent" : "Add a skill"}
        </button>
      )}

      <Modal open={step === "form"} onClose={closeAdd} title={agent ? "Add an agent" : "Add a skill"}>
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
        <div className="modal-actions">
          <button type="button" disabled={!ready} onClick={() => (setError(""), setStep("confirm"))}>
            Review
          </button>
          <button type="button" onClick={closeAdd}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal
        open={step === "confirm"}
        onClose={() => setStep("form")}
        title="Change your Claude setup?"
        role="alertdialog"
        description={`Create the ${noun} "${name}" in your ${noun}s folder${mode === "paste" ? ` from the pasted text (${new Blob([content]).size} bytes)` : ` by copying ${source.trim()}`}. Claude Code will load it in new sessions. Read it first if you did not write it.`}
      >
        {agent && mode === "paste" && (
          <p className="panel-note">
            Tools: {headerValue(content, "tools") || "not set, which means it can use every tool"}. Model: {headerValue(content, "model") || "not set (your default)"}.
          </p>
        )}
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void run(false)}>
            {busy ? "Working…" : "Confirm"}
          </button>
          <button type="button" disabled={busy} onClick={() => setStep("form")}>
            Back
          </button>
        </div>
      </Modal>

      <Modal
        open={pendingRemove !== null}
        onClose={() => (setError(""), onAskRemove(null))}
        title="Change your Claude setup?"
        role="alertdialog"
        description={`Move the ${noun} "${pendingRemove ?? ""}" from your ${noun}s folder to the trash folder. You can move it back by hand.`}
      >
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void run(true)}>
            {busy ? "Working…" : "Confirm"}
          </button>
          <button type="button" disabled={busy} onClick={() => (setError(""), onAskRemove(null))}>
            Cancel
          </button>
        </div>
      </Modal>

      <p role="status" aria-live="polite" className="form-message manager-status">
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
