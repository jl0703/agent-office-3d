import { RefreshCw, X } from "lucide-react";
import { useState, type Ref } from "react";
import type { VaultInfo } from "../../shared/vault.ts";
import { obsidianLink, searchTitles } from "./vault.ts";

type Props = {
  id: string;
  /** `loading` before the first answer, `null` when the server could not be reached. */
  vault: VaultInfo | "loading" | null;
  demo: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
  onRescan: () => void;
};

/** The knowledge hub: what the connected Obsidian vault holds. Titles only; notes open in Obsidian. */
export function HubPanel({ id, vault, demo, headingRef, onClose, onRescan }: Props) {
  const [query, setQuery] = useState("");
  const connected = vault !== null && vault !== "loading" && vault.connected ? vault : null;
  const found = connected ? searchTitles(connected.nodes, query) : [];
  // Reports written by the research team: dated file names sort by date, newest first.
  const reports = connected ? connected.nodes.filter((n) => /(^|\/)research\//.test(n.id)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10) : [];

  return (
    <aside id={id} className="panel" aria-labelledby={`${id}-title`}>
      <header className="panel-head">
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
          Knowledge hub
        </h2>
        <button type="button" className="icon-btn tip" aria-label="Close hub" data-tip="Close hub" onClick={onClose}>
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      {demo && <p className="panel-note">Demo mode: a made-up vault. Nothing is read from your files.</p>}
      {vault === "loading" && <p className="panel-note">Loading…</p>}
      {vault === null && <p className="panel-note">The vault could not be read: the server did not answer.</p>}
      {vault !== null && vault !== "loading" && !vault.connected && (
        <p className="panel-note">
          No vault connected. Set <span className="mono">OFFICE_VAULT_DIR</span> to the folder of your Obsidian vault and restart the server. Only note titles and links are read, never the text of a note, and nothing is written.
        </p>
      )}
      {connected && (
        <>
          <p>
            <strong>{connected.name}</strong> · {connected.noteCount} notes
            {connected.noteCount > connected.nodes.length && <span className="panel-note"> · the picture shows the {connected.nodes.length} most linked</span>}
          </p>
          <button type="button" onClick={onRescan}>
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Rescan
          </button>
          <label htmlFor={`${id}-search`}>Search note titles</label>
          <input id={`${id}-search`} type="search" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
          {query.trim() !== "" && (
            <ul className="note-list" aria-label="Matching notes">
              <li>
                <h3>Matches ({found.length})</h3>
              </li>
              {found.length === 0 && <li className="panel-note">No matching titles.</li>}
              {found.map((n) => (
                <li key={n.id}>
                  <a href={obsidianLink(connected.name, n.id)}>{n.title}</a>
                </li>
              ))}
            </ul>
          )}
          {reports.length > 0 && (
            <>
              <h3>Research reports</h3>
              <ul className="note-list" aria-label="Research reports, newest first">
                {reports.map((n) => (
                  <li key={n.id}>
                    <a href={obsidianLink(connected.name, n.id)}>{n.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Recent</h3>
          <ul className="note-list" aria-label="Recently changed notes">
            {connected.recent.map((n) => (
              <li key={n.path}>
                <a href={obsidianLink(connected.name, n.path)}>{n.title}</a>
                {Number.isFinite(new Date(n.mtime).getTime()) && <time dateTime={new Date(n.mtime).toISOString()}>{new Date(n.mtime).toLocaleDateString()}</time>}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
