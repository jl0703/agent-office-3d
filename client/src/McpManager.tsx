import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { addMcp, parseEnv, parseLines, previewMcp, removeMcp, type McpInput } from "./setup.ts";

type Pending = { kind: "add"; input: McpInput; command: string } | { kind: "remove"; name: string };

/** Add and remove MCP servers. The page shows the exact command first and nothing runs until Confirm. */
export function McpManager({ demo, showAdd = true, onChanged, pendingRemove, onAskRemove }: { demo: boolean; showAdd?: boolean; onChanged: () => void; pendingRemove: string | null; onAskRemove: (name: string | null) => void }) {
  const id = useId();
  const [remote, setRemote] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLElement | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null);
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const asking = pending !== null || pendingRemove !== null;

  useEffect(() => {
    if (pendingRemove) setPending(null);
  }, [pendingRemove]);
  useEffect(() => {
    if (asking) heading.current?.focus();
  }, [asking]);

  const ready = name.trim() !== "" && (remote ? url.trim() !== "" : command.trim() !== "");

  const review = async () => {
    const parsedEnv = parseEnv(env);
    if (!remote && parsedEnv === null) return setMessage("Each environment line must look like KEY=value.");
    const input: McpInput = remote
      ? { name: name.trim(), transport: "http", url: url.trim(), ...(parseLines(headers).length > 0 ? { headers: parseLines(headers) } : {}) }
      : { name: name.trim(), transport: "stdio", command: command.trim(), ...(parseLines(args).length > 0 ? { args: parseLines(args) } : {}), ...(parsedEnv && Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}) };
    setBusy(true);
    setMessage("");
    const result = demo ? ({ ok: true, command: `claude mcp add --scope user --transport ${input.transport} ${input.name} …` } as const) : await previewMcp(input);
    setBusy(false);
    if (result.ok && result.command) setPending({ kind: "add", input, command: result.command });
    else setMessage(result.ok ? "The preview was empty." : result.message);
  };

  const cancel = (p: Pending) => {
    setPending(null);
    onAskRemove(null);
    requestAnimationFrame(() => (p.kind === "add" ? reviewButton.current : document.querySelector<HTMLElement>(`[aria-label="Remove ${p.name}"]`))?.focus());
  };

  const run = async (p: Pending) => {
    setBusy(true);
    const result = demo ? ({ ok: true } as const) : p.kind === "remove" ? await removeMcp(p.name) : await addMcp(p.input);
    setBusy(false);
    setPending(null);
    onAskRemove(null);
    requestAnimationFrame(() => status.current?.focus());
    if (result.ok) {
      const label = p.kind === "add" ? p.input.name : p.name;
      setMessage(demo ? "Demo mode: nothing was changed." : p.kind === "add" ? `Added ${label}. New Claude Code sessions will start it when they need it.` : `Removed ${label}.`);
      if (p.kind === "add" && !demo) {
        setName("");
        setCommand("");
        setArgs("");
        setEnv("");
        setUrl("");
        setHeaders("");
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
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add an MCP server
        </summary>
        <p className="panel-note">A local program runs on this computer with your permissions. Only add one you trust. You will see the exact command before anything is saved.</p>
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
        <button type="button" ref={reviewButton} disabled={!ready || busy} onClick={() => void review()}>
          {busy ? "Checking…" : "Review the command"}
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
              ? `Remove the MCP server "${active.name}" from your Claude settings. Its program or service is not touched.`
              : "This command will be run to save the server. Claude Code will start a local program with your permissions whenever a session needs it. The office never starts it."}
          </p>
          {active.kind === "add" && (
            <pre className="command-preview" tabIndex={0} aria-label="The exact command">
              {active.command}
            </pre>
          )}
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
