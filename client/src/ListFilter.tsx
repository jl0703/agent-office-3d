import { Search, X } from "lucide-react";
import type { AgentStatus } from "../../shared/events.ts";
import { isFiltering, noFilter, type Filter } from "./filter.ts";
import { STATUS_WORD, StatusChip } from "./StatusChip.tsx";
import type { Ref } from "react";

const MEANING: Record<AgentStatus, string> = {
  working: "Busy: its monitor scrolls bars, the pennant is a triangle.",
  idle: "Waiting for a task: a blinking cursor, a flat bar pennant.",
  waiting: "Paused, often by a rate limit: three dots, a ring pennant.",
  done: "Finished: a tick on the monitor and on the pennant.",
  stopped: "Ended: a black monitor with a square, a square pennant.",
  error: "Failed: an X on the monitor, an upside-down triangle, a red beacon.",
  detached: "Lost when the server restarted: grey \"no signal\" bars, a ghosted figure.",
};

type Props = {
  filter: Filter;
  onChange: (next: Filter) => void;
  counts: { status: AgentStatus; count: number }[];
  /** How many sessions match, and how many there are. */
  shown: number;
  total: number;
  searchRef: Ref<HTMLInputElement>;
};

/** The search box and status chips above the session list, with a legend and the keyboard shortcuts. */
export function ListFilter({ filter, onChange, counts, shown, total, searchRef }: Props) {
  const toggle = (status: AgentStatus) => {
    const next = new Set(filter.statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange({ ...filter, statuses: next });
  };
  return (
    <section className="list-filter" aria-label="Search and filter sessions">
      <div className="search-row">
        <label htmlFor="session-search" className="sr-only">
          Search sessions
        </label>
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input
          id="session-search"
          ref={searchRef}
          type="search"
          value={filter.query}
          maxLength={100}
          placeholder="Search name, project, task…  ( / )"
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (filter.query !== "") onChange({ ...filter, query: "" });
              else e.currentTarget.blur();
            }
          }}
        />
        {isFiltering(filter) && (
          <button type="button" className="icon-btn tip" aria-label="Clear search and filters" data-tip="Clear" onClick={() => onChange(noFilter)}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
      {counts.length > 0 && (
        <div className="chips" role="group" aria-label="Filter by status">
          {counts.map(({ status, count }) => (
            <button key={status} type="button" className={`chip-filter chip-${status}`} aria-pressed={filter.statuses.has(status)} onClick={() => toggle(status)}>
              {STATUS_WORD[status]} <span className="chip-count">{count}</span>
            </button>
          ))}
        </div>
      )}
      <p className="note" role="status" aria-live="polite">
        {isFiltering(filter) ? `${shown} of ${total} sessions` : ""}
      </p>
      <details className="legend">
        <summary>Legend and shortcuts</summary>
        <ul className="legend-list">
          {(Object.keys(MEANING) as AgentStatus[]).map((s) => (
            <li key={s}>
              <StatusChip status={s} />
              <span>{MEANING[s]}</span>
            </li>
          ))}
        </ul>
        <p className="note">Pennant on each desk and the monitor repeat the status, so it never depends on colour alone. A line between two desks joins a master to its worker.</p>
        <dl className="keys">
          <dt>/</dt>
          <dd>search the list</dd>
          <dt>j and k</dt>
          <dd>next and previous session</dd>
          <dt>Enter</dt>
          <dd>open the focused session</dd>
          <dt>Esc</dt>
          <dd>close details, clear the search, or leave a room</dd>
        </dl>
      </details>
    </section>
  );
}
