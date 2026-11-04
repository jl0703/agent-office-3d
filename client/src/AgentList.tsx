import { useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../../shared/events.ts";
import type { TreeNode } from "./agents.ts";
import { StatusChip } from "./StatusChip.tsx";

export type RoomGroup = { key: string; title: string; count: number; errors: number; nodes: TreeNode[] };

type Controls = {
  stopping: ReadonlySet<string>;
  onStop: (id: string) => void;
  /** Why Stop buttons are switched off, or null. */
  stopOff?: string | null;
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** The room the office is focused on, and a way to focus one from here (the office offers the same by clicking). */
  focusedRoom?: string | null;
  onFocusRoom?: (key: string) => void;
  /** Id of the panel the rows open. */
  panelId?: string;
  rovingId: string | null;
  setRovingId: (id: string) => void;
};

/** A worker started here that has not ended yet. */
export const canStop = (agent: Agent) => agent.origin === "managed" && (agent.status === "working" || agent.status === "idle" || agent.status === "waiting");

function Row({ node, controls }: { node: TreeNode; controls: Controls }) {
  const { agent, children } = node;
  const selected = controls.selectedId === agent.id;
  return (
    <li className={`agent chip-border-${agent.status}${selected ? " agent-selected" : ""}${controls.hoveredId === agent.id ? " agent-hover" : ""}`}>
      <div className="agent-head">
        <button
          type="button"
          className="row-name"
          data-agent-id={agent.id}
          tabIndex={controls.rovingId === agent.id ? 0 : -1}
          aria-pressed={selected}
          aria-controls={controls.panelId}
          onClick={() => controls.onSelect?.(agent.id)}
          onMouseEnter={() => controls.onHover?.(agent.id)}
          onMouseLeave={() => controls.onHover?.(null)}
          onFocus={() => {
            controls.setRovingId(agent.id);
            controls.onHover?.(agent.id);
          }}
          onBlur={() => controls.onHover?.(null)}
        >
          <span className="row-label">{agent.name}</span>
        </button>
        <StatusChip status={agent.status} />
      </div>
      <p className="agent-meta">
        <span className="project">{agent.project}</span>
        <span className="origin">{agent.origin === "managed" ? "started here" : "watched"}</span>
      </p>
      {agent.note && <p className="note">{agent.note}</p>}
      <p className="activity">{agent.activity ?? "No tool used yet"}</p>
      {canStop(agent) && (
        <button
          type="button"
          className="stop"
          aria-label={`Stop ${agent.name}`}
          disabled={controls.stopping.has(agent.id) || Boolean(controls.stopOff)}
          title={controls.stopOff ?? undefined}
          onClick={() => controls.onStop(agent.id)}
        >
          <span className="stop-box" aria-hidden="true" />
          {controls.stopping.has(agent.id) ? "Stopping…" : "Stop"}
        </button>
      )}
      {children.length > 0 && (
        <ul aria-label={`Subagents of ${agent.name}`}>
          {children.map((child) => (
            <Row key={child.agent.id} node={child} controls={controls} />
          ))}
        </ul>
      )}
    </li>
  );
}

const flatten = (tree: TreeNode[]): string[] => tree.flatMap((n) => [n.agent.id, ...flatten(n.children)]);

export function AgentList({ groups, ...rest }: { groups: RoomGroup[] } & Omit<Controls, "rovingId" | "setRovingId">) {
  const [roving, setRoving] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const ids = flatten(groups.flatMap((g) => g.nodes));
  // One row is a tab stop: the one last focused, else the selected one, else the first.
  const rovingId = ids.includes(roving ?? "") ? roving : ids.includes(rest.selectedId ?? "") ? (rest.selectedId ?? null) : (ids[0] ?? null);

  if (ids.length === 0) {
    return <p className="empty-list">No active Claude Code sessions. A session appears here when it writes to its log.</p>;
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key) || !(e.target instanceof HTMLElement) || !e.target.matches("button.row-name")) return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.row-name") ?? [])];
    const at = rows.indexOf(e.target as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    rows[next]?.focus();
  };

  return (
    <div className="agent-groups" ref={list} onKeyDown={onKeyDown}>
      {groups.map((group, index) => (
        <section key={group.key} className="room-group" aria-labelledby={`room-group-${index}`}>
          <div className="room-head-row">
            <h3 id={`room-group-${index}`} className="room-head">
              {group.title}
              <span className="count">
                {" "}
                ({group.count}
                {group.errors > 0 ? `, ${group.errors} error` : ""})
              </span>
            </h3>
            {group.key !== "hidden" && rest.onFocusRoom && (
              <button type="button" className="link-btn" aria-pressed={rest.focusedRoom === group.key} onClick={() => rest.onFocusRoom?.(group.key)}>
                {rest.focusedRoom === group.key ? "Show all rooms" : "Show in office"}
              </button>
            )}
          </div>
          <ul aria-label={`Sessions in ${group.title}`} className="agents">
            {group.nodes.map((node) => (
              <Row key={node.agent.id} node={node} controls={{ ...rest, rovingId, setRovingId: setRoving }} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
