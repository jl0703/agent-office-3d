import { FlaskConical, LocateFixed, OctagonX, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { EVENT_TYPES, type ServerEvent } from "../../shared/events.ts";
import { AgentList, canStop } from "./AgentList.tsx";
import { AgentPanel, useActivityLog } from "./AgentPanel.tsx";
import { stopAgent, stopAll } from "./api.ts";
import { applyEvent, buildTree, initialState } from "./agents.ts";
import { VISIBLE_DESKS } from "./office/layout.ts";
import { useDemo, useMediaQuery } from "./office/hooks.ts";
import { OfficeCanvas } from "./office/OfficeCanvas.tsx";
import { selection, useSelection } from "./office/selection.ts";
import { StartForm } from "./StartForm.tsx";
import { STATUS_WORD } from "./StatusChip.tsx";
import "./theme/tokens.css";
import "./styles.css";

type Connection = "connecting" | "connected" | "disconnected";
type Tab = "office" | "list";

const ANNOUNCE_EVERY_MS = 5000;
const PANEL_ID = "agent-panel";

function ConnectionBadge({ connection }: { connection: Connection }) {
  const Icon = connection === "disconnected" ? WifiOff : Wifi;
  const text = { connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected, retrying" }[connection];
  return (
    <p role="status" className={`connection connection-${connection}`}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {text}
    </p>
  );
}

function App() {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [live, dispatch] = useReducer(applyEvent, initialState);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [stoppingAll, setStoppingAll] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [tab, setTab] = useState<Tab>("office");
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const demo = useDemo();
  const { selected, hovered } = useSelection();
  const narrow = useMediaQuery("(max-width: 600px)");
  const docked = useMediaQuery("(min-width: 1440px)");
  const startForm = useRef<HTMLDetailsElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const lastOpener = useRef<string | null>(null);
  const lastAnnounced = useRef({ at: 0, id: "", status: "" });

  useEffect(() => {
    const source = new EventSource("/events");
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("disconnected");
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        try {
          dispatch(JSON.parse((message as MessageEvent<string>).data) as ServerEvent);
        } catch {
          // Ignore a message that is not valid JSON.
        }
      });
    }
    return () => source.close();
  }, []);

  // In demo mode the page shows fake agents only; the real stream is ignored, not mixed in.
  const state = demo.active ? demo.state : live;
  useEffect(() => {
    selection.select(null);
  }, [demo.active]);

  const tree = useMemo(() => buildTree(state), [state]);
  const agents = useMemo(() => Object.values(state.agents), [state]);
  const current = selected ? state.agents[selected] : undefined;
  const runningHere = demo.active ? 0 : agents.filter(canStop).length;

  // Why Start and Stop are switched off, shown next to them.
  const off = demo.active ? "Switched off in demo mode." : connection !== "connected" ? (connection === "connecting" ? "Connecting…" : "Disconnected, retrying.") : null;

  // On a phone the panel opens from the strip under the office; elsewhere selecting opens it.
  useEffect(() => setExpanded(false), [selected]);
  const panelOpen = Boolean(current) && (!narrow || expanded);

  useEffect(() => {
    if (current && panelOpen && !docked) heading.current?.focus(); // the panel covers content: move into it
  }, [selected, panelOpen, docked]);

  useEffect(() => {
    if (selected) lastOpener.current = selected;
  }, [selected]);

  const close = useCallback(() => {
    const id = selected ?? lastOpener.current;
    selection.select(null);
    setExpanded(false);
    requestAnimationFrame(() => {
      const visible = (el: HTMLElement | null) => (el && el.offsetParent !== null ? el : null);
      const row = id ? visible(document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(id)}"]`)) : null;
      (row ?? visible(document.querySelector<HTMLElement>(".office-stage")) ?? document.querySelector<HTMLElement>("[role=tab][aria-selected=true]"))?.focus();
    });
  }, [selected]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirming) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen, confirming, close]);

  const stopAllButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);
  // The confirmation must not outlive the reason for it: no workers left, or the connection dropped.
  const confirmStale = confirming && (runningHere === 0 || Boolean(off));
  useEffect(() => {
    if (confirmStale) setConfirming(false);
  }, [confirmStale]);
  const leaveConfirm = () => {
    setConfirming(false);
    requestAnimationFrame(() => stopAllButton.current?.focus());
  };

  // Tell screen-reader users when the selected agent changes status, at most once every few seconds.
  useEffect(() => {
    if (!current) return;
    const last = lastAnnounced.current;
    if (last.id !== current.id) {
      lastAnnounced.current = { at: Date.now(), id: current.id, status: current.status };
      return;
    }
    if (last.status === current.status) return;
    // A change inside the quiet window is announced when the window ends, so a final status is never lost.
    const timer = setTimeout(
      () => {
        lastAnnounced.current = { at: Date.now(), id: current.id, status: current.status };
        setAnnouncement(`${current.name} is now ${STATUS_WORD[current.status]}`);
      },
      Math.max(0, ANNOUNCE_EVERY_MS - (Date.now() - last.at)),
    );
    return () => clearTimeout(timer);
  }, [current]);

  const log = useActivityLog(current, demo.log, demo.active);

  const onStop = useCallback(async (id: string) => {
    setNotice("");
    setStopping((s) => new Set(s).add(id));
    const result = await stopAgent(id);
    setStopping((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    if (!result.ok) setNotice(result.message);
  }, []);

  const onStopAll = useCallback(async () => {
    setConfirming(false);
    setNotice("");
    setStoppingAll(true);
    const result = await stopAll();
    setStoppingAll(false);
    if (!result.ok) setNotice(result.message);
  }, []);

  const [startRequested, setStartRequested] = useState(0);
  const openStartForm = () => {
    setTab("list");
    setStartRequested((n) => n + 1);
  };
  // Focus after the render that shows the list, so it also works on a phone where the list was hidden.
  useEffect(() => {
    if (startRequested === 0 || !startForm.current) return;
    startForm.current.open = true;
    startForm.current.querySelector("input")?.focus();
  }, [startRequested]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const order: Tab[] = ["office", "list"];
    const at = order.indexOf(tab);
    const target = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: order.length - 1 }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    const next = order[(target + order.length) % order.length]!;
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };

  const subagents = current ? agents.filter((a) => a.parentId === current.id).length : 0;
  const parent = current?.parentId ? state.agents[current.parentId] : undefined;

  return (
    <div className="app" data-tab={tab}>
      <header className="app-head">
        <h1>Agent Office</h1>
        <ConnectionBadge connection={connection} />
        <div className="app-actions">
          {demo.active ? (
            <button type="button" onClick={demo.stop}>
              <FlaskConical size={20} strokeWidth={1.75} aria-hidden="true" /> Exit demo
            </button>
          ) : (
            <button type="button" onClick={() => demo.start(20)}>
              <FlaskConical size={20} strokeWidth={1.75} aria-hidden="true" /> Demo
            </button>
          )}
          <button type="button" className="label-from-768 tip" aria-label="Reset view" data-tip="Reset view" onClick={() => setResetSignal((n) => n + 1)}>
            <LocateFixed size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>Reset view</span>
          </button>
          {confirming ? (
            <span className="confirm" role="group" aria-label="Confirm stopping all workers" onKeyDown={(e) => e.key === "Escape" && leaveConfirm()}>
              <span>Stop {runningHere} workers?</span>
              <button type="button" className="danger" disabled={confirmStale} onClick={() => void onStopAll()}>
                Confirm
              </button>
              <button type="button" ref={cancelButton} onClick={leaveConfirm}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="danger" ref={stopAllButton} disabled={stoppingAll || runningHere === 0 || Boolean(off)} title={off ?? (runningHere === 0 ? "No workers started here are running" : undefined)} onClick={() => setConfirming(true)}>
              <OctagonX size={20} strokeWidth={1.75} aria-hidden="true" /> {stoppingAll ? "Stopping…" : "Stop all"}
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        {demo.active && (
          <p className="demo-banner">
            <strong>DEMO MODE:</strong> fake agents, nothing here is real.
          </p>
        )}
        {connection === "disconnected" && !demo.active && <p className="stale-banner">Showing last known state. Start and Stop are off until the connection returns.</p>}
        <p role="alert" className="notice">
          {notice}
        </p>
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <div className="tabs" role="tablist" aria-label="View">
          {(["office", "list"] as const).map((t) => (
            <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`pane-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={onTabKey}>
              {t === "office" ? "Office" : `List (${agents.length})`}
            </button>
          ))}
        </div>

        <div className="workspace">
          <section className="pane pane-list" id="pane-list" role={narrow ? "tabpanel" : undefined} aria-labelledby={narrow ? "tab-list" : undefined} aria-label={narrow ? undefined : "Sessions"}>
            <StartForm ref={startForm} off={off} />
            <h2 className="list-title">
              Claude Code sessions <span className="count">({agents.length})</span>
            </h2>
            <p className="note">Sessions marked "started here" can be stopped. Sessions started anywhere else are view-only.</p>
            <AgentList
              tree={tree}
              stopping={stopping}
              onStop={(id) => void onStop(id)}
              stopOff={off}
              selectedId={selected}
              hoveredId={hovered}
              panelId={panelOpen ? PANEL_ID : undefined}
              onSelect={(id) => selection.select(id)}
              onHover={(id) => selection.hover(id)}
            />
          </section>

          <section className="pane pane-office" id="pane-office" role={narrow ? "tabpanel" : undefined} aria-labelledby={narrow ? "tab-office" : undefined}>
            <OfficeCanvas agents={agents} connection={connection} demo={demo.active} selection={selection} resetSignal={resetSignal} onTryDemo={() => demo.start(20)} onStartWorker={openStartForm} />
            {current && narrow && !expanded && (
              <button type="button" className="peek" onClick={() => setExpanded(true)}>
                <strong>{current.name}</strong> · {STATUS_WORD[current.status]} · Details
              </button>
            )}
          </section>

          <div className={`panel-slot${panelOpen ? " open" : ""}`}>
            {panelOpen && current ? (
              <AgentPanel
                id={PANEL_ID}
                agent={current}
                parent={parent}
                subagents={subagents}
                log={log}
                notShown={current.desk >= VISIBLE_DESKS}
                stopOff={off}
                stopping={stopping.has(current.id)}
                headingRef={heading}
                narrow={narrow}
                onClose={close}
                onSelect={(id) => selection.select(id)}
                onStop={(id) => void onStop(id)}
              />
            ) : (
              <p className="panel-empty">Select a session to see its details.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
