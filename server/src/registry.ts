import type { ActivityEntry, Agent, AgentStatus, ServerEvent } from "../../shared/events.ts";
import type { Fact } from "./transcript.ts";

type Init = Pick<Agent, "kind" | "parentId" | "project" | "name" | "currentTask"> & Partial<Pick<Agent, "origin" | "role" | "team" | "usd">>;
type Entry = {
  agent: Agent;
  pending: Set<string>;
  lastEventAt: number;
  finished: boolean;
  /** Set when an agent we started has ended; it overrides everything else. */
  terminal: "stopped" | "error" | "detached" | null;
  /** The subscription's usage limit was reached; the session is paused, not ended. */
  waiting: boolean;
  /** The last MAX_LOG tool calls, oldest first. */
  log: ActivityEntry[];
};

const MAX_PENDING = 200;
const MAX_LOG = 50;

export function createRegistry(opts: { now?: () => number; idleMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? 15_000;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: ServerEvent) => void>();
  const usedDesks = new Set<number>();

  const freeDesk = (): number => {
    let desk = 0;
    while (usedDesks.has(desk)) desk++;
    return desk;
  };

  const emit = (event: ServerEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  };

  const derive = (e: Entry): AgentStatus => {
    if (e.terminal) return e.terminal;
    if (e.waiting) return "waiting";
    if (e.finished) return "done";
    if (e.pending.size > 0) return "working";
    return now() - e.lastEventAt < idleMs ? "working" : "idle";
  };

  const refresh = (id: string, e: Entry) => {
    const status = derive(e);
    if (status === e.agent.status) return;
    e.agent.status = status;
    emit({ type: "agent.status", id, status });
  };

  return {
    upsert(id: string, init: Init) {
      if (entries.has(id)) return;
      const desk = freeDesk();
      usedDesks.add(desk);
      const agent: Agent = {
        id,
        kind: init.kind,
        origin: init.origin ?? "observed",
        role: init.role ?? (init.kind === "session" ? "solo" : "worker"),
        parentId: init.parentId,
        name: init.name,
        project: init.project,
        status: "idle",
        currentTask: init.currentTask,
        tool: null,
        activity: null,
        desk,
        updatedAt: new Date(now()).toISOString(),
        note: null,
        ...(init.team ? { team: init.team } : {}),
        ...(init.usd === undefined ? {} : { usd: init.usd }),
      };
      entries.set(id, { agent, pending: new Set(), lastEventAt: 0, finished: false, terminal: null, waiting: false, log: [] });
      emit({ type: "agent.spawned", agent: { ...agent } });
    },

    apply(id: string, facts: Fact[], lineTs: number | null) {
      const e = entries.get(id);
      if (!e) return;
      // A timestamp in the future must not keep an agent "working" forever.
      const at = Math.min(lineTs ?? now(), now());
      let changed = false;
      for (const fact of facts) {
        if (fact.kind === "title" && e.agent.name !== fact.text) {
          e.agent.name = fact.text;
          changed = true;
        } else if (fact.kind === "prompt" && e.agent.currentTask !== fact.text) {
          e.agent.currentTask = fact.text;
          changed = true;
        } else if (fact.kind === "tool_start") {
          if (e.pending.size < MAX_PENDING) e.pending.add(fact.id);
          e.agent.tool = fact.name;
          e.agent.activity = fact.summary;
          e.lastEventAt = Math.max(e.lastEventAt, at);
          const ts = new Date(at).toISOString();
          e.log.push({ ts, tool: fact.name, summary: fact.summary });
          if (e.log.length > MAX_LOG) e.log.shift();
          emit({ type: "agent.activity", id, tool: fact.name, summary: fact.summary, ts });
        } else if (fact.kind === "tool_end") {
          e.pending.delete(fact.id);
        } else if (fact.kind === "event") {
          e.lastEventAt = Math.max(e.lastEventAt, at);
        }
      }
      if (e.lastEventAt > 0) e.agent.updatedAt = new Date(e.lastEventAt).toISOString();
      if (changed) emit({ type: "agent.updated", agent: { ...e.agent } });
      refresh(id, e);
    },

    /** Forgets unanswered tool calls, for example when a log file was replaced. */
    clearPending(id: string) {
      const e = entries.get(id);
      if (!e) return;
      e.pending.clear();
      refresh(id, e);
    },

    /** Marks an agent we started as ended. Later facts no longer change its status. */
    setTerminal(id: string, status: "stopped" | "error" | "detached") {
      const e = entries.get(id);
      if (!e || e.terminal) return;
      e.terminal = status;
      e.pending.clear();
      refresh(id, e);
    },

    /** Brings an ended agent back to life, for example when it is resumed. */
    reopen(id: string) {
      const e = entries.get(id);
      if (!e) return;
      e.terminal = null;
      e.waiting = false;
      e.finished = false;
      e.lastEventAt = now();
      refresh(id, e);
    },

    setWaiting(id: string, waiting: boolean) {
      const e = entries.get(id);
      if (!e || e.waiting === waiting) return;
      e.waiting = waiting;
      refresh(id, e);
    },

    setNote(id: string, note: string | null) {
      const e = entries.get(id);
      const text = note === null ? null : note.slice(0, 200);
      if (!e || e.agent.note === text) return;
      e.agent.note = text;
      emit({ type: "agent.updated", agent: { ...e.agent } });
    },

    /** Only a changed value is announced, so a turn that costs nothing new sends nothing. */
    setUsd(id: string, usd: number) {
      const e = entries.get(id);
      if (!e || e.agent.usd === usd) return;
      e.agent.usd = usd;
      emit({ type: "agent.updated", agent: { ...e.agent } });
    },

    setFinished(id: string, finished: boolean) {
      const e = entries.get(id);
      if (!e || e.finished === finished) return;
      e.finished = finished;
      refresh(id, e);
    },

    refreshStatuses() {
      for (const [id, e] of entries) refresh(id, e);
    },

    remove(id: string) {
      const e = entries.get(id);
      if (!e || !entries.delete(id)) return;
      usedDesks.delete(e.agent.desk);
      emit({ type: "agent.removed", id });
    },

    get: (id: string): Agent | undefined => {
      const e = entries.get(id);
      return e ? { ...e.agent } : undefined;
    },
    has: (id: string) => entries.has(id),
    /** The agent's recent tool calls, oldest first, or undefined for an unknown agent. */
    events: (id: string): ActivityEntry[] | undefined => entries.get(id)?.log.map((entry) => ({ ...entry })),
    size: () => entries.size,
    pendingCount: (id: string) => entries.get(id)?.pending.size ?? 0,
    snapshot: (): Agent[] => [...entries.values()].map((e) => ({ ...e.agent })),

    subscribe(listener: (event: ServerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
