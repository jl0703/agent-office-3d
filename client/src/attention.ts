// What needs the person's attention, worked out from the agents the page already has.
import type { Agent } from "../../shared/events.ts";

export type AttentionKind = "error" | "cap" | "waiting" | "result";

export type Attention = { id: string; kind: AttentionKind; name: string; text: string };

const ORDER: Record<AttentionKind, number> = { error: 0, cap: 1, waiting: 2, result: 3 };
const FINISHED = ["idle", "done", "stopped"] as const;

const short = (text: string, max = 90) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("") + "…";
};

/**
 * Agents whose work finished since the person last looked: a worker started here that went from busy
 * to finished. `unseen` is the set carried from one call to the next; the result is the new set.
 * Opening an agent (`opened`) or its starting work again removes it.
 */
export function trackFinished(previous: ReadonlyMap<string, Agent["status"]>, agents: readonly Agent[], unseen: ReadonlySet<string>, opened: string | null): Set<string> {
  const next = new Set<string>();
  const present = new Map(agents.map((a) => [a.id, a]));
  for (const id of unseen) {
    const a = present.get(id);
    if (a && id !== opened && (FINISHED as readonly string[]).includes(a.status)) next.add(id);
  }
  for (const a of agents) {
    if (a.origin !== "managed" || a.id === opened) continue;
    const before = previous.get(a.id);
    if ((before === "working" || before === "waiting") && (FINISHED as readonly string[]).includes(a.status)) next.add(a.id);
  }
  return next;
}

/** The things to show in the "Needs you" list, most urgent first. */
export function attentionOf(agents: readonly Agent[], unseen: ReadonlySet<string>): Attention[] {
  const items: Attention[] = [];
  for (const a of agents) {
    if (a.status === "error") items.push({ id: a.id, kind: "error", name: a.name, text: short(a.note ?? a.activity ?? "Open it to see what went wrong") });
    else if (a.status === "stopped" && a.note && /usage cap/i.test(a.note)) items.push({ id: a.id, kind: "cap", name: a.name, text: short(a.note) });
    else if (a.status === "waiting") items.push({ id: a.id, kind: "waiting", name: a.name, text: short(a.note ?? "Open it to see why") });
    else if (unseen.has(a.id)) items.push({ id: a.id, kind: "result", name: a.name, text: "Finished: the result is ready" });
  }
  return items.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** The page title: a count of what needs attention, then the demo mark. */
export function pageTitle(count: number, demo: boolean): string {
  return `${count > 0 ? `(${count}) ` : ""}${demo ? "[Demo] " : ""}Agent Office`;
}
