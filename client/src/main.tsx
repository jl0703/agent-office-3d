import { BookOpen, FlaskConical, Hammer, Microscope, LayoutGrid, LocateFixed, OctagonX, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { EVENT_TYPES, type Agent, type AgentStatus, type ServerEvent } from "../../shared/events.ts";
import { AgentList, canStop, type RoomGroup } from "./AgentList.tsx";
import { attentionOf, pageTitle, RESEARCH_ID, trackFinished } from "./attention.ts";
import { countByStatus, filterTree, isFiltering, noFilter, step, type Filter } from "./filter.ts";
import { ListFilter } from "./ListFilter.tsx";
import { STATUSES } from "./office/palette.ts";
import { familyOf } from "./timeline.ts";
import { AgentPanel, useActivityLog, useAgentResult } from "./AgentPanel.tsx";
import { getUsage, getVault, stopAgent, stopAll, type Usage } from "./api.ts";
import { UsageMeter } from "./UsageMeter.tsx";
import { HubPanel } from "./HubPanel.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { demoFindings, getFindings } from "./research.ts";
import { CatalogPage, ItemPage } from "./CatalogPage.tsx";
import { FindPage } from "./FindPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TasksPage } from "./TasksPage.tsx";
import { TeamPage } from "./TeamPage.tsx";
import { demoTeam, getTeam, type Person } from "./team.ts";
import { hrefFor, KIND_WORD } from "./route.ts";
import { useRoute } from "./useRoute.ts";
import { ResearchBoard } from "./ResearchBoard.tsx";
import { WorkshopPanel } from "./WorkshopPanel.tsx";
import { demoVault } from "./vault.ts";
import type { VaultInfo } from "../../shared/vault.ts";
import { applyEvent, buildTree, initialState } from "./agents.ts";
import { assignRooms, emptyAssignment, roomName } from "./office/rooms.ts";
import { useDemo, useMediaQuery } from "./office/hooks.ts";
import { OfficeCanvas } from "./office/OfficeCanvas.tsx";
import { selection, useSelection } from "./office/selection.ts";
import { AutoApprove } from "./AutoApprove.tsx";
import { StartForm, type StartPreset } from "./StartForm.tsx";
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
  const route = useRoute();
  // The office's controls act on the office: from another page they take you there first.
  const toOffice = () => {
    if (route.page !== "office") window.location.hash = hrefFor({ page: "office" });
  };
  const [hubOpen, setHubOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [workshopOpen, setWorkshopOpen] = useState(false);
  const [newFindings, setNewFindings] = useState(0);
  // The team, for the role and the manager shown next to an agent: read now and every half minute.
  const [team, setTeam] = useState<Person[]>([]);
  const [preset, setPreset] = useState<StartPreset | null>(null);
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(new Set());
  const lastStatus = useRef(new Map<string, AgentStatus>());
  const [usage, setUsage] = useState<Usage | null>(null);
  const [filter, setFilter] = useState<Filter>(noFilter);
  const searchRef = useRef<HTMLInputElement>(null);
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | "loading" | null>("loading");
  const demo = useDemo();
  const { selected, hovered, room } = useSelection();
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

  // The usage figure is asked for every ten seconds while connected.
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    const load = () => void getUsage().then((u) => !cancelled && setUsage(u));
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection]);

  useEffect(() => {
    if (demo.active) return setTeam(demoTeam());
    if (connection !== "connected") return;
    let cancelled = false;
    const load = () => void getTeam().then((p) => !cancelled && p && setTeam(p));
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [demo.active, connection]);

  // How many findings wait for a decision: shown on the Research button and in "Needs you".
  useEffect(() => {
    if (demo.active) {
      setNewFindings(demoFindings().filter((f) => f.status === "new").length);
      return;
    }
    if (connection !== "connected") return;
    let cancelled = false;
    const load = () => void getFindings().then((r) => !cancelled && setNewFindings(r ? r.findings.filter((f) => f.status === "new").length : 0));
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, demo.active, researchOpen]);

  const loadVault = useCallback((refresh: boolean) => {
    void getVault(refresh).then(setVaultInfo);
  }, []);
  useEffect(() => loadVault(false), [loadVault]);

  // In demo mode the page shows fake agents only; the real stream is ignored, not mixed in.
  const state = demo.active ? demo.state : live;
  const demoNotes = useMemo(() => demoVault(), []);
  const shownVault: VaultInfo | "loading" | null = demo.active ? demoNotes : vaultInfo;
  const vault = shownVault !== null && shownVault !== "loading" && shownVault.connected ? shownVault : null;
  useEffect(() => {
    selection.select(null);
    selection.focusRoom(null);
  }, [demo.active]);

  const tree = useMemo(() => buildTree(state), [state]);
  const agents = useMemo(() => Object.values(state.agents), [state]);
  const current = selected ? state.agents[selected] : undefined;

  // What needs the person: failures, caps, waiting, and finished work they have not opened yet.
  useEffect(() => {
    const before = lastStatus.current;
    lastStatus.current = new Map(agents.map((a) => [a.id, a.status]));
    setUnseen((u) => trackFinished(before, agents, u, selected));
  }, [agents, selected]);
  const needs = useMemo(() => attentionOf(agents, unseen, newFindings), [agents, unseen, newFindings]);
  useEffect(() => {
    if (route.page === "find") return; // the find's own page names itself
    document.title = route.page === "office" ? pageTitle(needs.length, demo.active) : route.page === "settings" ? "Settings - Agent Office" : route.page === "tasks" ? "Tasks - Agent Office" : route.page === "team" ? "Team - Agent Office" : `${KIND_WORD[route.kind]}${route.page === "item" ? `: ${route.name}` : ""} - Agent Office`;
  }, [needs.length, demo.active, route]);

  // A new page announces itself: focus goes to its title (not on the first load).
  const lastRoute = useRef(hrefFor(route));
  useEffect(() => {
    const now = hrefFor(route);
    if (now === lastRoute.current) return;
    lastRoute.current = now;
    if (route.page === "office" && (hubOpen || researchOpen || workshopOpen)) return; // an office panel just opened and takes the focus itself
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#catalog-title, .app-head h1")?.focus());
  }, [route]);

  // Rooms keep their places while agents come and go, so the previous answer is part of the input.
  const placed = useRef(emptyAssignment);
  const assignment = useMemo(() => {
    const next = assignRooms(placed.current, agents);
    placed.current = next;
    return next;
  }, [agents]);
  const groups = useMemo<RoomGroup[]>(() => {
    const byRoom = new Map<string, typeof tree>();
    for (const node of tree) byRoom.set(assignment.roomOf.get(node.agent.id) ?? "", [...(byRoom.get(assignment.roomOf.get(node.agent.id) ?? "") ?? []), node]);
    const count = (nodes: typeof tree): Agent[] => nodes.flatMap((n) => [n.agent, ...count(n.children)]);
    return [...byRoom]
      .sort(([a], [b]) => (assignment.roomSlot.get(a) ?? 99) - (assignment.roomSlot.get(b) ?? 99))
      .map(([key, nodes]) => {
        const members = count(nodes);
        return { key: key === "" ? "hidden" : key, title: key === "" ? "Not shown in the office view" : roomName(key), count: members.length, errors: members.filter((m) => m.status === "error").length, nodes };
      });
  }, [tree, assignment]);
  const inRoom = useMemo(() => (room === null ? groups : groups.filter((g) => g.key === room)), [groups, room]);
  // The search and status chips narrow the list; the office itself always shows everyone.
  const shownGroups = useMemo(() => (isFiltering(filter) ? inRoom.map((g) => ({ ...g, nodes: filterTree(g.nodes, filter) })).filter((g) => g.nodes.length > 0) : inRoom), [inRoom, filter]);
  const matchCount = useMemo(() => {
    const count = (nodes: typeof tree): number => nodes.reduce((n, node) => n + 1 + count(node.children), 0);
    return shownGroups.reduce((n, g) => n + count(g.nodes), 0);
  }, [shownGroups]);
  const statusCounts = useMemo(() => countByStatus(agents, STATUSES, filter.statuses), [agents, filter.statuses]);
  // "N of M" counts what the list could show: the focused room's sessions, or all of them.
  const listTotal = useMemo(() => {
    const count = (nodes: typeof tree): number => nodes.reduce((n, node) => n + 1 + count(node.children), 0);
    return inRoom.reduce((n, g) => n + count(g.nodes), 0);
  }, [inRoom]);
  const runningHere = demo.active ? 0 : agents.filter(canStop).length;

  // Why Start and Stop are switched off, shown next to them.
  const off = demo.active ? "Switched off in demo mode." : connection !== "connected" ? (connection === "connecting" ? "Connecting…" : "Disconnected, retrying.") : null;

  // On a phone the panel opens from the strip under the office; elsewhere selecting opens it.
  useEffect(() => {
    if (selected !== null) {
      setExpanded(false);
      setHubOpen(false);
      setResearchOpen(false);
      setWorkshopOpen(false);
    }
  }, [selected]);
  const panelOpen = (Boolean(current) || hubOpen || researchOpen || workshopOpen) && (!narrow || expanded);
  const openHub = () => {
    toOffice();
    selection.select(null);
    setResearchOpen(false);
    setWorkshopOpen(false);
    setHubOpen(true);
    setExpanded(true);
  };
  const openResearch = () => {
    toOffice();
    selection.select(null);
    setHubOpen(false);
    setWorkshopOpen(false);
    setResearchOpen(true);
    setExpanded(true);
  };
  const openWorkshop = () => {
    toOffice();
    selection.select(null);
    setHubOpen(false);
    setResearchOpen(false);
    setWorkshopOpen(true);
    setExpanded(true);
  };
  // A finding handed to a master: the start form opens with the brief in it.
  const handToMaster = (brief: string) => {
    toOffice();
    setPreset((p) => ({ prompt: brief, nonce: (p?.nonce ?? 0) + 1 }));
    setResearchOpen(false);
    setWorkshopOpen(false);
    setHubOpen(false);
    setExpanded(false);
    setTab("list");
  };

  useEffect(() => {
    if ((current || hubOpen || researchOpen || workshopOpen) && panelOpen && !docked) heading.current?.focus(); // the panel covers content: move into it
  }, [selected, panelOpen, docked, hubOpen, researchOpen, workshopOpen]);

  useEffect(() => {
    if (selected) lastOpener.current = selected;
  }, [selected]);

  const close = useCallback(() => {
    if (hubOpen || researchOpen || workshopOpen) {
      const button = hubOpen ? "[data-hub-button]" : workshopOpen ? "[data-workshop-button]" : "[data-research-button]";
      setHubOpen(false);
      setResearchOpen(false);
      setWorkshopOpen(false);
      setExpanded(false);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(button)?.focus());
      return;
    }
    const id = selected ?? lastOpener.current;
    selection.select(null);
    setExpanded(false);
    requestAnimationFrame(() => {
      const visible = (el: HTMLElement | null) => (el && el.offsetParent !== null ? el : null);
      const row = id ? visible(document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(id)}"]`)) : null;
      (row ?? visible(document.querySelector<HTMLElement>(".office-stage")) ?? document.querySelector<HTMLElement>("[role=tab][aria-selected=true]"))?.focus();
    });
  }, [selected, hubOpen, researchOpen, workshopOpen]);

  useEffect(() => {
    if (!panelOpen && room === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirming) return;
      if (panelOpen) close();
      else selection.focusRoom(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen, room, confirming, close]);

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
  const result = useAgentResult(current, !demo.active);
  const family = useMemo(() => (current ? familyOf(agents, current.id) : null), [agents, current]);

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

  // Keyboard shortcuts: / searches, j and k move between sessions. They never fire while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) return;
      if (e.key === "/") {
        e.preventDefault();
        setTab("list");
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (e.key === "j" || e.key === "k") {
        const rows = [...document.querySelectorAll<HTMLButtonElement>("button.row-name")].filter((b) => b.offsetParent !== null);
        const active = rows.find((b) => b === document.activeElement);
        const next = step(rows, active, e.key === "j" ? 1 : -1);
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
      <Sidebar route={route} demo={demo.active} />
      <header className="app-head">
        {route.page === "office" ? (
          <h1 tabIndex={-1}>Agent Office</h1>
        ) : (
          <a className="app-title" href={hrefFor({ page: "office" })}>
            Agent Office
          </a>
        )}
        <ConnectionBadge connection={connection} />
        <UsageMeter usage={demo.active ? { totalUsd: 3.4, caps: { runUsd: 2, sessionUsd: 5, totalUsd: 20 } } : usage} demo={demo.active} />
        <div className="app-actions">
          <NeedsYou items={needs} onOpen={(id) => (id === RESEARCH_ID ? openResearch() : (toOffice(), selection.select(id)))} />
          {demo.active ? (
            <button type="button" onClick={demo.stop}>
              <FlaskConical size={20} strokeWidth={1.75} aria-hidden="true" /> Exit demo
            </button>
          ) : (
            <button type="button" onClick={() => demo.start(20)}>
              <FlaskConical size={20} strokeWidth={1.75} aria-hidden="true" /> Demo
            </button>
          )}
          <button type="button" data-research-button className="label-from-768 tip" aria-label={`Research department${newFindings > 0 ? `, ${newFindings} new` : ""}`} data-tip="Research department" aria-pressed={researchOpen} onClick={openResearch}>
            <Microscope size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>Research{newFindings > 0 ? ` (${newFindings})` : ""}</span>
          </button>
          <button type="button" data-workshop-button className="label-from-768 tip" aria-label="Workshop" data-tip="Workshop" aria-pressed={workshopOpen} onClick={openWorkshop}>
            <Hammer size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>Workshop</span>
          </button>
          <button type="button" data-hub-button className="label-from-768 tip" aria-label="Knowledge hub" data-tip="Knowledge hub" aria-pressed={hubOpen} onClick={openHub}>
            <BookOpen size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>Knowledge hub</span>
          </button>
          {room !== null && (
            <button type="button" onClick={() => (toOffice(), selection.focusRoom(null))}>
              <LayoutGrid size={20} strokeWidth={1.75} aria-hidden="true" /> Overview
            </button>
          )}
          <button type="button" className="label-from-768 tip" aria-label="Reset view" data-tip="Reset view" onClick={() => (toOffice(), setResetSignal((n) => n + 1))}>
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

      {route.page === "office" ? (
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
            <StartForm ref={startForm} off={off} preset={preset} />
            <AutoApprove off={demo.active ? "Not available in demo mode." : off} />
            <h2 className="list-title">
              Claude Code sessions <span className="count">({agents.length})</span>
            </h2>
            <p className="note">Sessions marked "started here" can be stopped. Sessions started anywhere else are view-only.</p>
            <ListFilter filter={filter} onChange={setFilter} counts={statusCounts} shown={matchCount} total={listTotal} searchRef={searchRef} />
          <AgentList
            team={team}
            emptyText={isFiltering(filter) ? "No sessions match. Clear the search or the status chips." : undefined}
              groups={shownGroups}
            focusedRoom={room}
            onFocusRoom={(key) => selection.focusRoom(room === key ? null : key)}
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
            <OfficeCanvas agents={agents} team={team} connection={connection} demo={demo.active} assignment={assignment} vault={vault} hubOpen={hubOpen} newFindings={newFindings} onOpenHub={openHub} selection={selection} resetSignal={resetSignal} onTryDemo={() => demo.start(20)} onStartWorker={openStartForm} />
            {current && !hubOpen && !researchOpen && !workshopOpen && narrow && !expanded && (
              <button type="button" className="peek" onClick={() => setExpanded(true)}>
                <strong>{current.name}</strong> · {STATUS_WORD[current.status]} · Details
              </button>
            )}
          </section>

          <div className={`panel-slot${panelOpen ? " open" : ""}`}>
            {panelOpen && workshopOpen ? (
              <WorkshopPanel id={PANEL_ID} demo={demo.active} off={off} headingRef={heading} onClose={close} />
            ) : panelOpen && researchOpen ? (
              <ResearchBoard id={PANEL_ID} demo={demo.active} off={off} headingRef={heading} onClose={close} onHand={handToMaster} />
            ) : panelOpen && hubOpen ? (
            <HubPanel id={PANEL_ID} vault={shownVault} demo={demo.active} headingRef={heading} onClose={close} onRescan={() => loadVault(true)} off={off} onPlanAgain={handToMaster} />
          ) : panelOpen && current ? (
              <AgentPanel
                id={PANEL_ID}
                team={team}
                agent={current}
                parent={parent}
                subagents={subagents}
                log={log}
              result={result}
              usage={usage}
              family={family}
                notShown={!assignment.seat.has(current.id)}
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
      ) : route.page === "list" ? (
        <CatalogPage key={hrefFor(route)} kind={route.kind} demo={demo.active} />
      ) : route.page === "team" ? (
        <TeamPage demo={demo.active} />
      ) : route.page === "tasks" ? (
        <TasksPage agents={agents} demo={demo.active} onOpenAgent={(id) => (toOffice(), selection.select(id))} />
      ) : route.page === "settings" ? (
        <SettingsPage demo={demo.active} off={off} usage={usage} onStartDemo={() => demo.start(20)} onStopDemo={demo.stop} />
      ) : route.page === "find" ? (
        <FindPage key={hrefFor(route)} id={route.id} demo={demo.active} />
      ) : (
        <ItemPage key={hrefFor(route)} kind={route.kind} name={route.name} demo={demo.active} onGone={() => (window.location.hash = hrefFor({ page: "list", kind: route.kind }))} />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
