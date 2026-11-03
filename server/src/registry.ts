import type { Agent, AgentStatus, ServerEvent } from "../../shared/events.ts";
import type { Fact } from "./transcript.ts";

type Init = Pick<Agent, "kind" | "parentId" | "project" | "name" | "currentTask">;
type Entry = { agent: Agent; pending: Set<string>; lastEventAt: number; finished: boolean };

const MAX_PENDING = 200;

export function createRegistry(opts: { now?: () => number; idleMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? 15_000;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: ServerEvent) => void>();

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
      const agent: Agent = {
        id,
        origin: "observed",
        role: init.kind === "session" ? "solo" : "worker",
        status: "idle",
        tool: null,
        activity: null,
        updatedAt: new Date(now()).toISOString(),
        ...init,
      };
      entries.set(id, { agent, pending: new Set(), lastEventAt: 0, finished: false });
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
          emit({ type: "agent.activity", id, tool: fact.name, summary: fact.summary, ts: new Date(at).toISOString() });
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
      if (entries.delete(id)) emit({ type: "agent.removed", id });
    },

    get: (id: string): Agent | undefined => {
      const e = entries.get(id);
      return e ? { ...e.agent } : undefined;
    },
    has: (id: string) => entries.has(id),
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
