import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Status = "connecting" | "connected" | "disconnected";

const LABELS: Record<Status, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected. Open the one-time URL printed in the terminal.",
};

function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [lastBeat, setLastBeat] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource("/events");
    source.onopen = () => setStatus("connected");
    source.onerror = () => setStatus("disconnected");
    source.addEventListener("heartbeat", (event) => {
      setLastBeat((JSON.parse((event as MessageEvent<string>).data) as { ts: string }).ts);
    });
    return () => source.close();
  }, []);

  return (
    <main>
      <h1>Agent Office</h1>
      <p role="status">{LABELS[status]}</p>
      <p>Last heartbeat: {lastBeat ?? "none yet"}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
