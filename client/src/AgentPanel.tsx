import { ArrowLeft, Network, X } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import type { ActivityEntry, Agent } from "../../shared/events.ts";
import { getAgentEvents, getAgentResult, type Usage } from "./api.ts";
import { canStop } from "./AgentList.tsx";
import { StatusChip } from "./StatusChip.tsx";
import { WorkerControls } from "./WorkerControls.tsx";

const LOG_REFRESH_MS = 1000;
const TASK_PREVIEW = 120;

/** The last tool calls of one agent. Real agents ask the server; demo agents read the demo world. */
export function useActivityLog(agent: Agent | undefined, demoLog: (id: string) => ActivityEntry[] | undefined, demo: boolean) {
  const [log, setLog] = useState<ActivityEntry[] | "loading" | "error">("loading");
  const id = agent?.id;
  const stamp = agent?.updatedAt;
  const loaded = useRef<string | null>(null);
  const lastFetch = useRef(0);

  useEffect(() => {
    if (!id) return;
    if (loaded.current !== id) setLog("loading");
    if (demo) {
      setLog([...(demoLog(id) ?? [])]);
      loaded.current = id;
      return;
    }
    let cancelled = false;
    // Activity arrives in bursts; one request a second is enough.
    const timer = setTimeout(
      () => {
        void getAgentEvents(id).then((events) => {
          if (cancelled) return;
          loaded.current = id;
          setLog(events ?? "error");
        });
        lastFetch.current = Date.now();
      },
      // At most one request a second, however often the agent reports: wait out what is left of the second.
      loaded.current === id ? Math.max(0, LOG_REFRESH_MS - (Date.now() - lastFetch.current)) : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, stamp, demo, demoLog]);

  return log;
}

const FINISHED = ["idle", "done", "stopped", "error"];

/** The last final answer of a worker started here, once its turn has ended. */
export function useAgentResult(agent: Agent | undefined, enabled: boolean) {
  const [result, setResult] = useState<string | null | undefined>(null);
  const id = agent?.id;
  const stamp = agent?.updatedAt;
  const finished = Boolean(agent && agent.origin === "managed" && FINISHED.includes(agent.status));
  useEffect(() => {
    setResult(null); // never keep another agent's text on screen while this one's loads
    if (!id || !finished || !enabled) return;
    let cancelled = false;
    void getAgentResult(id).then((text) => {
      if (!cancelled) setResult(text);
    });
    return () => {
      cancelled = true;
    };
  }, [id, stamp, finished, enabled]);
  return result;
}

/** The result text with a Copy button. Plain text only. */
function ResultBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };
  return (
    <>
      <div className="result-head">
        <h3>Result</h3>
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="result" tabIndex={0} role="region" aria-label="Last result of this worker">
        {text}
      </pre>
    </>
  );
}

type PanelProps = {
  id: string;
  agent: Agent;
  parent: Agent | undefined;
  subagents: number;
  log: ActivityEntry[] | "loading" | "error";
  /** The worker's last final answer: text, null for none yet, undefined when it could not be read. */
  result: string | null | undefined;
  usage: Usage | null;
  /** The agent has no desk in the office view. */
  notShown: boolean;
  stopOff: string | null;
  stopping: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  /** Phone layout: the panel fills the screen and closes with a Back button. */
  narrow: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
};

export function AgentPanel({ id, agent, parent, subagents, log, result, usage, notShown, stopOff, stopping, headingRef, narrow, onClose, onSelect, onStop }: PanelProps) {
  const [fullTask, setFullTask] = useState(false);
  useEffect(() => setFullTask(false), [agent.id]);
  const task = agent.currentTask;
  const longTask = task !== null && task.length > TASK_PREVIEW;

  return (
    <aside id={id} className="panel" aria-labelledby={`${id}-title`}>
      <div className="sheet-handle" aria-hidden="true" />
      <header className="panel-head">
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="clamp-2">
          {agent.name}
        </h2>
        <button type="button" className="icon-btn tip" aria-label={narrow ? "Back" : "Close details"} data-tip={narrow ? undefined : "Close details"} onClick={onClose}>
          {narrow ? <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" /> : <X size={20} strokeWidth={1.75} aria-hidden="true" />}
          {narrow && "Back"}
        </button>
      </header>
      <div className="panel-chips">
        <StatusChip status={agent.status} />
        {agent.team === "research" && <span className="role-chip">Research</span>}
        {agent.role === "master" && (
          <span className="role-chip">
            <Network size={16} strokeWidth={1.75} aria-hidden="true" />
            Master
          </span>
        )}
        <span className="origin">{agent.origin === "managed" ? "started here" : "watched"}</span>
      </div>
      {agent.note && <p className="panel-note">{agent.note}</p>}
      {notShown && <p className="panel-note">Not shown in the office view: all desks are taken.</p>}
      <dl className="panel-facts">
        <dt>Project</dt>
        <dd>{agent.project}</dd>
        <dt>{parent ? "Parent" : "Subagents"}</dt>
        <dd>
          {parent ? (
            <button type="button" className="link-btn" onClick={() => onSelect(parent.id)}>
              {parent.name}
            </button>
          ) : (
            subagents
          )}
        </dd>
        <dt>Current task</dt>
        <dd className="task-text">
          {task === null ? "None" : fullTask || !longTask ? task : `${task.slice(0, TASK_PREVIEW)}…`}
          {longTask && (
            <button type="button" className="link-btn" aria-expanded={fullTask} onClick={() => setFullTask((v) => !v)}>
              {fullTask ? "Show less" : "Show full"}
            </button>
          )}
        </dd>
        {agent.usd !== undefined && (
          <>
            <dt>Usage</dt>
            <dd>
              {`$${agent.usd.toFixed(2)}`}
              {usage ? ` of $${usage.caps.sessionUsd.toFixed(2)} for this session` : ""}
            </dd>
          </>
        )}
        <dt>Latest</dt>
        <dd className="mono">{agent.activity ? `${agent.tool ?? "tool"}: ${agent.activity}` : "No tool used yet"}</dd>
      </dl>
      {canStop(agent) && (
        <button type="button" className="danger" disabled={stopping || Boolean(stopOff)} title={stopOff ?? undefined} onClick={() => onStop(agent.id)}>
          <span className="stop-box" aria-hidden="true" />
          {stopping ? "Stopping…" : "Stop"}
        </button>
      )}
      <WorkerControls key={`${agent.id}-${canStop(agent)}`} agent={agent} off={stopOff} />
      {canStop(agent) && stopOff && <p className="panel-note">{stopOff}</p>}
      {typeof result === "string" && result !== "" && <ResultBox text={result} />}
      {result === undefined && <p className="panel-note">The result could not be read.</p>}
      <h3>Activity</h3>
      {log === "loading" && <p className="panel-note">Loading…</p>}
      {log === "error" && <p className="panel-note">The activity log could not be loaded.</p>}
      {Array.isArray(log) && log.length === 0 && <p className="panel-note">No activity yet.</p>}
      {Array.isArray(log) && log.length > 0 && (
        <ol className="log" aria-label="Recent activity, newest first">
          {[...log].reverse().map((entry, i) => (
            <li key={`${entry.ts}-${i}`}>
              <time dateTime={entry.ts}>{new Date(entry.ts).toLocaleTimeString()}</time>
              <span className="mono">{entry.tool ?? "tool"}</span>
              <span className="clamp-2">{entry.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
