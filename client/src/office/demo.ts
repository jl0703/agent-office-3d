import type { ActivityEntry, Agent, AgentStatus, ServerEvent } from "../../../shared/events.ts";
import { STATUSES } from "./palette.ts";

// Fake agents for trying the office without real sessions. Nothing here touches the server.

const SESSION_NAMES = [
  "Refactor billing module",
  "Fix flaky checkout tests",
  // Deliberately hostile text: it must always show as plain text.
  "Check <img src=x onerror=alert(1)> escaping",
  "Investigate the intermittent timeout in the payment reconciliation job",
  "Migrate docs to the new site",
  "Profile the search index",
];
const SUBAGENT_NAMES = ["Explore", "Review", "Plan", "Test runner", "Lint fixer", "Docs writer"];
const PROJECTS = ["api-server", "web-app", "docs", "infra", "mobile"];
const TOOLS: [string, string][] = [
  ["Read", "Read config.ts"],
  ["Edit", "Edit invoice.ts"],
  ["Grep", "Grep retry"],
  ["Write", "Write notes.md"],
  ["Glob", "Glob **/*.test.ts"],
  ["WebSearch", "WebSearch vite proxy headers"],
];
const DELEGATED = ["Fix the flaky checkout tests", "Review the billing refactor", "Profile the search index", "Update the API docs", "Check <b>markup</b> stays text", "Migrate the old config format"];
const MAX_LOG = 50;

export type DemoWorld = {
  agents: Map<string, Agent>;
  log: Map<string, ActivityEntry[]>;
  nextChange: Map<string, number>;
  cycle: Map<string, { order: AgentStatus[]; at: number }>;
  rng: () => number;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDemoWorld(count: number, seed = 7, nowMs = Date.now()): DemoWorld {
  const n = Math.max(1, Math.min(Math.floor(count) || 1, 200));
  const rng = mulberry32(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)] as T;
  const sessions = Math.max(1, Math.round(n / 5));
  const world: DemoWorld = { agents: new Map(), log: new Map(), nextChange: new Map(), cycle: new Map(), rng };

  for (let i = 0; i < n; i++) {
    const isSession = i < sessions;
    const id = `demo-${i + 1}`;
    const order = [...STATUSES];
    for (let k = order.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [order[k], order[j]] = [order[j] as AgentStatus, order[k] as AgentStatus];
    }
    const status = order[0] as AgentStatus;
    const base = SESSION_NAMES[i % SESSION_NAMES.length] as string;
    const [tool, activity] = pick(TOOLS);
    world.agents.set(id, {
      id,
      kind: isSession ? "session" : "subagent",
      origin: i % 3 === 0 ? "managed" : "observed",
      role: isSession ? (i === 0 ? "master" : "solo") : "worker",
      parentId: isSession ? null : `demo-${(i % sessions) + 1}`,
      name: isSession ? (i >= SESSION_NAMES.length ? `${base} ${Math.floor(i / SESSION_NAMES.length) + 1}` : base) : pick(SUBAGENT_NAMES),
      // A subagent works in its parent's folder, so it sits in its parent's room.
      project: isSession ? pick(PROJECTS) : (world.agents.get(`demo-${(i % sessions) + 1}`)?.project ?? pick(PROJECTS)),
      status,
      currentTask: isSession ? "Work through the open items and report back" : "Help the main session with one part of the job",
      tool,
      activity,
      desk: i,
      updatedAt: new Date(nowMs).toISOString(),
      note: null,
      ...(isSession && i === 0
        ? { phase: "planning" as const, plan: { goal: "Add a settings page with tests", steps: ["Read the existing pages", "Add the route and form", "Write tests", "Run lint and tests"], files: ["src/settings"], workers: 2, costUsd: 1.2, risks: "Touches the shared layout.", undo: "Revert the branch.", status: "pending" as const } }
        : {}),
    });
    world.log.set(id, [{ ts: new Date(nowMs).toISOString(), tool, summary: activity }]);
    world.nextChange.set(id, nowMs + 2000 + rng() * 4000);
    world.cycle.set(id, { order, at: 0 });
  }
  return world;
}

export function demoSnapshot(world: DemoWorld): ServerEvent {
  return { type: "snapshot", agents: [...world.agents.values()].map((a) => ({ ...a })) };
}

/** Moves the demo forward to `nowMs` and returns the events a real server would have sent. */
export function stepDemo(world: DemoWorld, nowMs: number): ServerEvent[] {
  const events: ServerEvent[] = [];
  for (const [id, due] of world.nextChange) {
    if (due > nowMs) continue;
    const agent = world.agents.get(id);
    const cycle = world.cycle.get(id);
    if (!agent || !cycle) continue;
    cycle.at = (cycle.at + 1) % cycle.order.length;
    const status = cycle.order[cycle.at] as AgentStatus;
    agent.status = status;
    agent.updatedAt = new Date(nowMs).toISOString();
    events.push({ type: "agent.status", id, status });
    if (status === "working" && agent.parentId !== null) {
      // A fresh job from its master, so the demo shows the hand-over.
      agent.currentTask = DELEGATED[Math.floor(world.rng() * DELEGATED.length)] as string;
      events.push({ type: "agent.updated", agent: { ...agent } });
    }
    if (status === "working") {
      const [tool, summary] = TOOLS[Math.floor(world.rng() * TOOLS.length)] as [string, string];
      agent.tool = tool;
      agent.activity = summary;
      const ts = new Date(nowMs).toISOString();
      const log = world.log.get(id) ?? [];
      log.push({ ts, tool, summary });
      if (log.length > MAX_LOG) log.shift();
      world.log.set(id, log);
      events.push({ type: "agent.activity", id, tool, summary, ts });
    }
    world.nextChange.set(id, nowMs + 2000 + world.rng() * 4000);
  }
  return events;
}
