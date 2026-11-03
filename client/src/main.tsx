import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { EVENT_TYPES, type ServerEvent } from "../../shared/events.ts";
import { AgentList, canStop } from "./AgentList.tsx";
import { stopAgent, stopAll } from "./api.ts";
import { applyEvent, buildTree, initialState } from "./agents.ts";
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
  const [state, dispatch] = useReducer(applyEvent, initialState);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [stoppingAll, setStoppingAll] = useState(false);

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
  const agents = Object.values(state.agents);
  const runningHere = agents.filter(canStop).length;

  return (
    <main>
      <h1>Agent Office</h1>
      <p role="status" className={`connection connection-${connection}`}>
        {LABELS[connection]}
      </p>
      <StartForm />
      <h2>
        Claude Code sessions <span className="count">({agents.length})</span>
      </h2>
      <p className="note">
        Sessions marked "started here" can be stopped. Sessions started anywhere else are view-only.
      </p>
      {runningHere > 0 && (
        <button type="button" disabled={stoppingAll} onClick={() => void onStopAll()}>
          {stoppingAll ? "Stopping…" : `Stop all workers (${runningHere})`}
        </button>
      )}
      <p role="alert" className="notice">
        {notice}
      </p>
      <AgentList tree={tree} stopping={stopping} onStop={(id) => void onStop(id)} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
