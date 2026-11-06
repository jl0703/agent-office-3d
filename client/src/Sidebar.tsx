import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { RemoveButton, SkillManager } from "./SkillManager.tsx";
import { demoSetup, describeServer, getSetup, matches, type Setup } from "./setup.ts";

type Section = "skills" | "mcp";

/** The hamburger button and the left drawer with the owner's skills and MCP servers. Read only for now. */
export function Sidebar({ demo }: { demo: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>("skills");
  const [setup, setSetup] = useState<Setup | "loading" | null>("loading");
  const [query, setQuery] = useState("");
  const [reloads, setReloads] = useState(0);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (demo) return setSetup(demoSetup());
    let live = true;
    // One failed refresh must not replace a list that is already shown.
    void getSetup().then((s) => live && setSetup((now) => (s === null && typeof now === "object" && now !== null ? now : s)));
    return () => {
      live = false;
    };
  }, [open, demo, reloads]);

  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const ready = typeof setup === "object" && setup !== null ? setup : null;
  const skills = ready ? ready.skills.filter((s) => matches(`${s.name} ${s.description}`, query)) : [];
  const servers = ready ? ready.mcp.filter((s) => matches(s.name, query)) : [];

  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn tip"
        aria-label="Skills and MCP servers"
        data-tip="Skills and MCP servers"
        aria-expanded={open}
        aria-controls={`${id}-drawer`}
        data-sidebar-button
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && <div className="drawer-backdrop" onClick={close} aria-hidden="true" />}
      {open && (
        <aside id={`${id}-drawer`} className="drawer" aria-labelledby={`${id}-title`}>
          <header className="panel-head">
            <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
              Your setup
            </h2>
            <button type="button" className="icon-btn tip" aria-label="Close menu" data-tip="Close menu" onClick={close}>
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </header>
          {demo && <p className="panel-note">Demo mode: made-up skills and servers.</p>}
          <div className="chips" role="group" aria-label="Choose a list">
            <button type="button" className="chip-filter" aria-pressed={section === "skills"} onClick={() => setSection("skills")}>
              Skills{ready ? ` (${ready.skills.length})` : ""}
            </button>
            <button type="button" className="chip-filter" aria-pressed={section === "mcp"} onClick={() => setSection("mcp")}>
              MCP servers{ready ? ` (${ready.mcp.length})` : ""}
            </button>
          </div>
          <label htmlFor={`${id}-find`}>Find</label>
          <input id={`${id}-find`} type="search" value={query} maxLength={60} onChange={(e) => setQuery(e.target.value)} placeholder={section === "skills" ? "Search skills" : "Search servers"} />

          {setup === "loading" && <p className="panel-note">Loading…</p>}
          {setup === null && <p className="panel-note">Your setup could not be read.</p>}
          {ready && ready.canManage && (
            <div hidden={section !== "skills"}>
              <SkillManager demo={demo} off={false} onChanged={() => setReloads((n) => n + 1)} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />
            </div>
          )}
          {ready && section === "skills" && (
            <ul className="note-list setup-list" aria-label="Skills">
              {skills.map((s) => (
                <li key={s.name} className={s.added ? "setup-row" : undefined}>
                  <div>
                    <strong>{s.name}</strong>
                    {s.added && <span className="origin"> added here</span>}
                    {s.description && <span className="panel-note"> {s.description}</span>}
                  </div>
                  {s.added && ready.canManage && <RemoveButton name={s.name} onAsk={setPendingRemove} disabled={pendingRemove !== null} />}
                </li>
              ))}
              {skills.length === 0 && <li className="panel-note">{ready.skills.length === 0 ? "No skills found in your skills folder." : "No skill matches."}</li>}
            </ul>
          )}
          {ready && section === "mcp" && (
            <ul className="note-list setup-list" aria-label="MCP servers">
              {servers.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong>
                  <span className="panel-note">{describeServer(s)}</span>
                </li>
              ))}
              {servers.length === 0 && <li className="panel-note">{ready.mcp.length === 0 ? "No user-level MCP servers found." : "No server matches."}</li>}
            </ul>
          )}
          <p className="panel-note">Secret values are never shown. {section === "skills" ? "Only skills added here can be removed here." : "Adding and removing MCP servers comes next."}</p>
        </aside>
      )}
    </>
  );
}
