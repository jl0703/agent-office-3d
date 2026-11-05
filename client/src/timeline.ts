// The activity of one agent as a timeline, and the family it belongs to. Pure functions, no clock of their own.
import type { ActivityEntry, Agent } from "../../shared/events.ts";

/** "just now", "12 s ago", "3 min ago", "2 h ago", then the date. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(then).toLocaleDateString();
}

/** "0.8 s", "4 s", "2 min 5 s". */
export function shortDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 9.95) return `${Math.round(s * 10) / 10} s`;
  const whole = Math.round(s); // round first, then split, so 59.6 s is "1 min 0 s" and not "60 s"
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60);
  return `${m} min ${whole - m * 60} s`;
}

export type TimelineItem = {
  key: string;
  ts: string;
  tool: string;
  summary: string;
  /** How many identical calls in a row this item stands for. */
  count: number;
  /** Time until the next call began (or until now for the newest, when the agent is still working); null when unknown. */
  durationMs: number | null;
  /** The duration relative to the longest on the timeline, 0 to 1. */
  share: number;
};

/**
 * Newest first. Identical consecutive calls are folded into one item with a count. The duration of a
 * call is the time until the next one began: the best the log can say about how long it took.
 */
export function timelineOf(entries: readonly ActivityEntry[], now: number, working: boolean): TimelineItem[] {
  const folded: { entry: ActivityEntry; count: number; lastTs: string }[] = [];
  for (const entry of entries) {
    const last = folded[folded.length - 1];
    if (last && last.entry.tool === entry.tool && last.entry.summary === entry.summary) {
      last.count++;
      last.lastTs = entry.ts;
    } else folded.push({ entry, count: 1, lastTs: entry.ts });
  }
  const items: TimelineItem[] = folded.map((f, i) => {
    const next = folded[i + 1];
    const from = Date.parse(f.entry.ts);
    // The clock may be a moment older than the newest entry: never let that hide the live row.
    const until = next ? Date.parse(next.entry.ts) : working ? Math.max(now, from) : NaN;
    const durationMs = Number.isFinite(from) && Number.isFinite(until) && until >= from ? until - from : null;
    return { key: `${f.entry.ts}-${i}`, ts: f.lastTs, tool: f.entry.tool ?? "tool", summary: f.entry.summary, count: f.count, durationMs, share: 0 };
  });
  const longest = Math.max(0, ...items.map((i) => i.durationMs ?? 0));
  for (const item of items) item.share = longest > 0 && item.durationMs !== null ? Math.min(1, item.durationMs / longest) : 0;
  return items.reverse();
}

export type Family = { root: Agent; members: { agent: Agent; depth: number }[] };

/** The session an agent belongs to (its topmost parent) and everyone below it, in tree order. Null when it is on its own. */
export function familyOf(agents: readonly Agent[], id: string): Family | null {
  const byId = new Map(agents.map((a) => [a.id, a]));
  let root = byId.get(id);
  if (!root) return null;
  const seen = new Set<string>();
  while (root.parentId !== null && byId.has(root.parentId) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.parentId) as Agent;
  }
  const children = new Map<string, Agent[]>();
  for (const a of agents) {
    if (a.parentId !== null && a.id !== root.id) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);
  }
  const members: Family["members"] = [];
  const visited = new Set<string>([root.id]);
  const walk = (parent: Agent, depth: number) => {
    for (const child of (children.get(parent.id) ?? []).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      members.push({ agent: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return members.length === 0 ? null : { root, members };
}
