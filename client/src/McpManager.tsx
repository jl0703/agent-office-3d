import { Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal.tsx";
import { addMcp, parseEnv, parseLines, previewMcp, removeMcp, type McpInput } from "./setup.ts";

type Step = "closed" | "form" | "confirm";

/**
 * Add and remove MCP servers. The add form, the exact command and the remove question each open in a pop-up window, and
 * nothing runs until Confirm. Put this next to the list's heading: the "Add" button is what it shows on the page.
 */
export function McpManager({ demo, showAdd = true, onChanged, pendingRemove, onAskRemove }: { demo: boolean; showAdd?: boolean; onChanged: () => void; pendingRemove: string | null; onAskRemove: (name: string | null) => void }) {
  const id = useId();
  const [step, setStep] = useState<Step>("closed");
  const [remote, setRemote] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [prepared, setPrepared] = useState<{ input: McpInput; command: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (pendingRemove) setStep("closed");
  }, [pendingRemove]);

  const ready = name.trim() !== "" && (remote ? url.trim() !== "" : command.trim() !== "");

  const review = async () => {
    const parsedEnv = parseEnv(env);
    if (!remote && parsedEnv === null) return setError("Each environment line must look like KEY=value.");
    const input: McpInput = remote
      ? { name: name.trim(), transport: "http", url: url.trim(), ...(parseLines(headers).length > 0 ? { headers: parseLines(headers) } : {}) }
      : { name: name.trim(), transport: "stdio", command: command.trim(), ...(parseLines(args).length > 0 ? { args: parseLines(args) } : {}), ...(parsedEnv && Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}) };
    setBusy(true);
    setError("");
    const result = demo ? ({ ok: true, command: `claude mcp add --scope user --transport ${input.transport} ${input.name} …` } as const) : await previewMcp(input);
    setBusy(false);
    if (result.ok && result.command) {
      setPrepared({ input, command: result.command });
      setStep("confirm");
    } else {
      setError(result.ok ? "The preview was empty." : result.message);
    }
  };

  const run = async (remove: boolean) => {
    setBusy(true);
    setError("");
    const target = remove ? (pendingRemove ?? "") : (prepared?.input.name ?? "");
    const result = demo ? ({ ok: true } as const) : remove ? await removeMcp(target) : prepared ? await addMcp(prepared.input) : ({ ok: false, message: "Nothing to add." } as const);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setStep("closed");
    setPrepared(null);
    onAskRemove(null);
    setMessage(demo ? "Demo mode: nothing was changed." : remove ? `Removed ${target}.` : `Added ${target}. New Claude Code sessions will start it when they need it.`);
    if (!remove && !demo) {
      setName("");
      setCommand("");
      setArgs("");
      setEnv("");
      setUrl("");
      setHeaders("");
    }
    onChanged();
  };

  const closeAdd = () => {
    setStep("closed");
    setError("");
    setPrepared(null); // the prepared command holds environment values and headers: do not keep them
  };
  const back = () => {
    setError("");
    setStep("form");
  };

  return (
    <div className="manager">
      {showAdd && (
        <button type="button" className="add-btn" onClick={() => setStep("form")}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add an MCP server
        </button>
      )}

      <Modal open={step === "form"} onClose={closeAdd} title="Add an MCP server" description="A local program runs on this computer with your permissions. Only add one you trust. You will see the exact command before anything is saved.">
        <div className="chips" role="group" aria-label="Kind of server">
          <button type="button" className="chip-filter" aria-pressed={!remote} onClick={() => setRemote(false)}>
            Local program
          </button>
          <button type="button" className="chip-filter" aria-pressed={remote} onClick={() => setRemote(true)}>
            Remote (HTTP)
          </button>
        </div>
        <label htmlFor={`${id}-name`}>Server name</label>
        <input id={`${id}-name`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
        {remote ? (
          <>
            <label htmlFor={`${id}-url`}>Address (https, or http://localhost)</label>
            <input id={`${id}-url`} value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            <label htmlFor={`${id}-headers`}>Headers (one per line, like Name: value)</label>
            <textarea id={`${id}-headers`} rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} />
          </>
        ) : (
          <>
            <label htmlFor={`${id}-command`}>Command</label>
            <input id={`${id}-command`} value={command} maxLength={200} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            <label htmlFor={`${id}-args`}>Arguments (one per line)</label>
            <textarea id={`${id}-args`} rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\nmy-mcp-server"} />
            <label htmlFor={`${id}-env`}>Environment values (one per line, like KEY=value)</label>
            <textarea id={`${id}-env`} rows={3} value={env} onChange={(e) => setEnv(e.target.value)} />
          </>
        )}
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={!ready || busy} onClick={() => void review()}>
            {busy ? "Checking…" : "Review the command"}
          </button>
          <button type="button" onClick={closeAdd}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal
        open={step === "confirm" && prepared !== null}
        onClose={() => !busy && back()}
        title="Change your Claude setup?"
        role="alertdialog"
        description="This command will be run to save the server. Claude Code will start a local program with your permissions whenever a session needs it. The office never starts it."
      >
        <pre className="command-preview" tabIndex={0} aria-label="The exact command">
          {prepared?.command}
        </pre>
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void run(false)}>
            {busy ? "Working…" : "Confirm"}
          </button>
          <button type="button" disabled={busy} onClick={back}>
            Back
          </button>
        </div>
      </Modal>

      <Modal
        open={pendingRemove !== null}
        onClose={() => !busy && (setError(""), onAskRemove(null))}
        title="Change your Claude setup?"
        role="alertdialog"
        description={`Remove the MCP server "${pendingRemove ?? ""}" from your Claude settings. Its program or service is not touched.`}
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
