import { useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { EVENT_TYPES, type ServerEvent } from "../../shared/events.ts";
import { AgentList } from "./AgentList.tsx";
import { applyEvent, buildTree, initialState } from "./agents.ts";
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

  const tree = useMemo(() => buildTree(state), [state]);
  const count = Object.keys(state.agents).length;

  return (
    <main>
      <h1>Agent Office</h1>
      <p role="status" className={`connection connection-${connection}`}>
        {LABELS[connection]}
      </p>
      <h2>
        Claude Code sessions <span className="count">({count})</span>
      </h2>
      <p className="note">View only. Sessions started outside this app cannot be controlled from here.</p>
      <AgentList tree={tree} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
