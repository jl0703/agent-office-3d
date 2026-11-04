import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { EVENT_TYPES, type ServerEvent } from "../../shared/events.ts";
import { AgentList, canStop } from "./AgentList.tsx";
import { stopAgent, stopAll } from "./api.ts";
import { applyEvent, buildTree, initialState } from "./agents.ts";
import { useDemo } from "./office/hooks.ts";
import { OfficeCanvas } from "./office/OfficeCanvas.tsx";
import { selection, useSelection } from "./office/selection.ts";
import { SelectedBar } from "./SelectedBar.tsx";
import { StartForm } from "./StartForm.tsx";
import "./styles.css";

type Connection = "connecting" | "connected" | "disconnected";

const LABELS: Record<Connection, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected. Open the one-time URL printed in the terminal.",
};

function App() {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [live, dispatch] = useReducer(applyEvent, initialState);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [stoppingAll, setStoppingAll] = useState(false);
  const demo = useDemo();
  const { selected, hovered } = useSelection();

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

  const onStop = useCallback(async (id: string) => {
    setNotice("");
    setStopping((current) => new Set(current).add(id));
    const result = await stopAgent(id);
    setStopping((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (!result.ok) setNotice(result.message);
  }, []);

  const onStopAll = useCallback(async () => {
    setNotice("");
    setStoppingAll(true);
    const result = await stopAll();
    setStoppingAll(false);
    if (!result.ok) setNotice(result.message);
  }, []);

  const tree = useMemo(() => buildTree(state), [state]);
  const agents = useMemo(() => Object.values(state.agents), [state]);
  const runningHere = demo.active ? 0 : agents.filter(canStop).length;
  const current = selected ? state.agents[selected] : undefined;

  return (
    <main>
      <h1>Agent Office</h1>
      <p role="status" className={`connection connection-${connection}`}>
        {LABELS[connection]}
      </p>
      {demo.active && (
        <p className="demo-banner">
          <strong>DEMO MODE:</strong> fake agents, nothing here is real.
          <button type="button" onClick={demo.stop}>
            Exit demo
          </button>
        </p>
      )}
      <OfficeCanvas agents={agents} connection={connection} demo={demo.active} selection={selection} onTryDemo={() => demo.start(20)} onExitDemo={demo.stop} />
      {current && <SelectedBar agent={current} onClose={() => selection.select(null)} />}
      <StartForm disabled={demo.active} />
      <h2>
        Claude Code sessions <span className="count">({agents.length})</span>
      </h2>
      <p className="note">Sessions marked "started here" can be stopped. Sessions started anywhere else are view-only.</p>
      {runningHere > 0 && (
        <button type="button" disabled={stoppingAll} onClick={() => void onStopAll()}>
          {stoppingAll ? "Stopping…" : `Stop all workers (${runningHere})`}
        </button>
      )}
      <p role="alert" className="notice">
        {notice}
      </p>
      <AgentList
        tree={tree}
        stopping={stopping}
        onStop={(id) => void onStop(id)}
        readOnly={demo.active}
        selectedId={selected}
        hoveredId={hovered}
        onSelect={(id) => selection.select(id)}
        onHover={(id) => selection.hover(id)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
