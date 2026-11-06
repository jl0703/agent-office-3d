import { ExternalLink, RefreshCw, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type Ref } from "react";
import { briefFor, byNewest, DECISION_WORD, DECISIONS, demoFindings, getConfig, getFindings, getSchedule, KIND_WORD, KINDS, safeLink, saveConfig, SCHEDULE_MODES, setDecision, setSchedule, SKIP_WORD, startSweep, type Decision, type Finding, type Kind, type ResearchConfig, type Schedule, type ScheduleMode } from "./research.ts";

type Props = {
  id: string;
  demo: boolean;
  /** Why starting work is switched off (demo, disconnected), or null. */
  off: string | null;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
  onHand: (brief: string) => void;
};

const POLL_MS = 15_000;

function Card({ f, off, onChange, onHand }: { f: Finding; off: string | null; onChange: (id: string, status: Decision, note?: string) => void; onHand: (brief: string) => void }) {
  const [note, setNote] = useState(f.note ?? "");
  useEffect(() => setNote(f.note ?? ""), [f.note]);
  return (
    <article className={`finding finding-${f.status}`} aria-label={f.title}>
      <header>
        <h3>
          {safeLink(f.url) ? (
            <a href={f.url} target="_blank" rel="noopener noreferrer">
              {f.title} <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="sr-only"> (opens GitHub or the source in a new tab)</span>
            </a>
          ) : (
            f.title
          )}
        </h3>
        <p className="finding-chips">
          <span className="role-chip">{KIND_WORD[f.kind]}</span>
          <span className="origin" title="How well it fits what the office needs">
            Relevance {f.relevance}/5
          </span>
          {f.stars !== undefined && <span className="origin">★ {f.stars.toLocaleString()}</span>}
          {f.license && <span className="origin">{f.license}</span>}
          <span className="origin">Effort {f.effort}</span>
          <span className={`origin risk-${f.risk}`}>Risk {f.risk}</span>
        </p>
      </header>
      <p>{f.why}</p>
      {f.improves && <p className="panel-note">Improves: {f.improves}</p>}
      <p className="note">
        Found by {f.found_by} on {f.date}
      </p>
      <div className="decisions" role="group" aria-label={`Decision for ${f.title}`}>
        {DECISIONS.map((d) => (
          <button key={d} type="button" aria-pressed={f.status === d} onClick={() => onChange(f.id, d, note || undefined)}>
            {DECISION_WORD[d]}
          </button>
        ))}
      </div>
      {f.status !== "new" && (
        <label className="finding-note">
          Your note
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (f.note ?? "") && onChange(f.id, f.status, note || undefined)} />
        </label>
      )}
      {(f.status === "looking" || f.status === "adopt") && (
        <button type="button" disabled={Boolean(off)} title={off ?? undefined} onClick={() => onHand(briefFor(f))}>
          <Send size={16} strokeWidth={1.75} aria-hidden="true" /> Hand to a master
        </button>
      )}
    </article>
  );
}

/** The research department's board: findings to judge, the focus list and needs, and the sweep button. */
export function ResearchBoard({ id, demo, off, headingRef, onClose, onHand }: Props) {
  const [findings, setFindings] = useState<Finding[] | "loading" | null>("loading");
  const [invalid, setInvalid] = useState(0);
  const [kinds, setKinds] = useState<ReadonlySet<Kind>>(new Set());
  const [statuses, setStatuses] = useState<ReadonlySet<Decision>>(new Set());
  const [message, setMessage] = useState("");
  const [config, setConfig] = useState<ResearchConfig | null>(null);
  const [focusText, setFocusText] = useState("");
  const [needsText, setNeedsText] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const [schedule, setScheduleState] = useState<Schedule | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = useCallback(async () => {
    if (demo) {
      setFindings(demoFindings());
      return;
    }
    const got = await getFindings();
    setFindings(got ? got.findings : null);
    setInvalid(got?.invalid ?? 0);
  }, [demo]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (demo) return;
    void getConfig().then((c) => {
      setConfig(c);
      setFocusText(c?.focus.join("\n") ?? "");
      setNeedsText(c?.needs ?? "");
    });
  }, [demo]);

  useEffect(() => {
    if (!demo) void getSchedule().then(setScheduleState);
  }, [demo]);

  const changeSchedule = async (mode: ScheduleMode) => {
    setSavingSchedule(true);
    const result = await setSchedule(mode);
    setMessage(result.ok ? (mode === "off" ? "Automatic sweeps are off." : `Automatic sweeps are ${mode}. The first one runs after the first ${mode === "daily" ? "day" : "week"}.`) : result.message);
    const fresh = await getSchedule();
    if (fresh) setScheduleState(fresh);
    setSavingSchedule(false);
  };

  const decide = async (fid: string, status: Decision, note?: string) => {
    if (demo) {
      setFindings((list) => (Array.isArray(list) ? list.map((f) => (f.id === fid ? { ...f, status, ...(note ? { note } : {}) } : f)) : list));
      return;
    }
    const result = await setDecision(fid, status, note);
    setMessage(result.ok ? "" : result.message);
    await load();
  };

  const sweep = async () => {
    setSweeping(true);
    const result = await startSweep();
    setSweeping(false);
    setMessage(result.ok ? "Sweep started. New findings appear here as the team files them." : result.message);
  };

  const save = async () => {
    const focus = focusText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (focus.some((l) => l.startsWith("#"))) return setMessage("Topic lines cannot start with #.");
    const result = await saveConfig({ focus, needs: needsText });
    setMessage(result.ok ? "Saved." : result.message);
  };

  const list = useMemo(
    () => (Array.isArray(findings) ? findings.filter((f) => (kinds.size === 0 || kinds.has(f.kind)) && (statuses.size === 0 || statuses.has(f.status))).sort(byNewest) : []),
    [findings, kinds, statuses],
  );
  const newCount = Array.isArray(findings) ? findings.filter((f) => f.status === "new").length : 0;

  const toggle = <T extends string>(set: ReadonlySet<T>, value: T, apply: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <aside id={id} className="panel board" aria-labelledby={`${id}-title`}>
      <header className="panel-head">
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
          Research department
        </h2>
        <button type="button" className="icon-btn tip" aria-label="Close research" data-tip="Close research" onClick={onClose}>
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      {demo && <p className="panel-note">Demo mode: made-up findings. Nothing here is real.</p>}
      <p className="panel-note">
        A standing team looks for skills, MCP servers, repositories and ideas that could help this office. You decide what happens to each finding; nothing is installed for you.
      </p>
      <div className="board-actions">
        <button type="button" disabled={sweeping || Boolean(off)} title={off ?? undefined} onClick={() => void sweep()}>
          <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> {sweeping ? "Starting…" : "Run a sweep now"}
        </button>
        <span className="panel-note">{off ?? "A sweep usually costs about $1 of your subscription (capped at about $3; at most $10 in the worst case)."}</span>
      </div>
      <p role="status" aria-live="polite" className="form-message">
        {message}
      </p>

      {!demo && schedule && (
        <div className="board-schedule">
          <label htmlFor={`${id}-schedule`}>Automatic sweeps</label>
          <select id={`${id}-schedule`} value={schedule.mode} disabled={Boolean(off) || savingSchedule} onChange={(e) => void changeSchedule(e.target.value as ScheduleMode)}>
            {SCHEDULE_MODES.map((m) => (
              <option key={m} value={m}>
                {m === "off" ? "Off" : m === "daily" ? "Daily" : "Weekly"}
              </option>
            ))}
          </select>
          <span className="panel-note">
            {schedule.mode === "off" ? "Sweeps run only when you press the button." : `Runs only while this server is running. Next: ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "after the first interval"}.`}
            {schedule.lastSkipped ? ` Last skipped because ${SKIP_WORD[schedule.lastSkipped.reason] ?? "it could not start"}.` : ""}
          </span>
        </div>
      )}

      <details className="board-config">
        <summary>Focus list and office needs</summary>
        {demo || !config ? (
          <p className="panel-note">{demo ? "Not available in demo mode." : "The research folder is not set up yet (set OFFICE_VAULT_DIR and restart the server)."}</p>
        ) : (
          <>
            <label htmlFor={`${id}-focus`}>Topics to watch (one per line)</label>
            <textarea id={`${id}-focus`} rows={5} value={focusText} onChange={(e) => setFocusText(e.target.value)} />
            <label htmlFor={`${id}-needs`}>What this office needs (the team scores findings against it)</label>
            <textarea id={`${id}-needs`} rows={6} maxLength={4000} value={needsText} onChange={(e) => setNeedsText(e.target.value)} />
            <button type="button" onClick={() => void save()}>
              Save
            </button>
          </>
        )}
      </details>

      <div className="chips" role="group" aria-label="Filter findings by kind">
        {KINDS.map((k) => (
          <button key={k} type="button" className="chip-filter" aria-pressed={kinds.has(k)} onClick={() => toggle(kinds, k, setKinds)}>
            {KIND_WORD[k]}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Filter findings by decision">
        {DECISIONS.map((d) => (
          <button key={d} type="button" className="chip-filter" aria-pressed={statuses.has(d)} onClick={() => toggle(statuses, d, setStatuses)}>
            {DECISION_WORD[d]}
          </button>
        ))}
      </div>

      {findings === "loading" && <p className="panel-note">Loading…</p>}
      {findings === null && <p className="panel-note">The findings could not be read. Is the research folder set up?</p>}
      {Array.isArray(findings) && findings.length === 0 && <p className="panel-note">No findings yet. Run a sweep, and the team will file what it finds here.</p>}
      {Array.isArray(findings) && findings.length > 0 && (
        <p className="panel-note" role="status" aria-live="polite">
          {list.length} of {findings.length} findings, {newCount} new
          {invalid > 0 ? `; ${invalid} notes could not be read` : ""}
        </p>
      )}
      <div className="findings">
        {list.map((f) => (
          <Card key={f.id} f={f} off={off} onChange={(fid, s, n) => void decide(fid, s, n)} onHand={onHand} />
        ))}
      </div>
    </aside>
  );
}
