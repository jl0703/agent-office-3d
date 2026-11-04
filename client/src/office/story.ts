// What the characters do between themselves, worked out from the agents the page already has: a master
// walks to a worker to hand it a task, a worker walks to its master to report, and working agents
// now and then say what they are doing. No clock of its own: the caller passes the time in milliseconds.
import type { Agent, AgentStatus } from "../../../shared/events.ts";
import { pointAlong, routeLength, walkRoute, WALK_SPEED, type Point } from "./paths.ts";

export const MAX_WALKERS = 4;
export const MAX_BUBBLES = 4;
export const HOLD_MS = 2500;
export const TOOL_BUBBLE_EVERY_MS = 8000;
export const TOOL_BUBBLE_MS = 3500;
export const REDUCED_BUBBLE_MS = 2000;
export const MAX_TEXT = 80;

const FINISHED: readonly AgentStatus[] = ["done", "error", "stopped"];
const isFinished = (s: AgentStatus) => FINISHED.includes(s);

/** One line of at most `max` characters (not UTF-16 units), with an ellipsis when cut. */
export function shorten(text: string, max = MAX_TEXT): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("") + "…";
}

export type Walker = { agentId: string; x: number; z: number; heading: number; moving: boolean };
export type Bubble = { agentId: string; text: string };
export type StoryFrame = { walkers: Walker[]; bubbles: Bubble[] };

type Job = {
  walker: string;
  target: string;
  startedAt: number;
  out: Point[];
  back: Point[];
  outMs: number;
  backMs: number;
};

type Remembered = { status: AgentStatus; task: string | null; activity: string | null };
type Speech = { text: string; from: number; until: number };

export type ObserveOptions = {
  /** The system asks for less motion: nobody walks, bubbles stay at their desks. */
  reduced: boolean;
  /** The connection is down: show the last state without any story. */
  frozen: boolean;
};

export function createStory() {
  let known = new Map<string, Remembered>();
  let started = false;
  let jobs: Job[] = [];
  let speech = new Map<string, Speech>();
  const lastTool = new Map<string, number>();

  const put = (agentId: string, words: Speech) => {
    speech.set(agentId, words);
    if (speech.size > MAX_BUBBLES) {
      // Drop the one that ends first.
      const oldest = [...speech].sort((a, b) => a[1].until - b[1].until)[0];
      if (oldest) speech.delete(oldest[0]);
    }
  };
  const say = (agentId: string, text: string, from: number, ms: number) => put(agentId, { text: shorten(text), from, until: from + ms });

  /** A walk from `walker` to a spot beside `target`, a pause, and back. Falls back to a bubble at the desk. */
  function visit(walker: Agent, target: Agent, seats: ReadonlyMap<string, number>, text: string, speaker: Agent, now: number, reduced: boolean) {
    const from = seats.get(walker.id);
    const to = seats.get(target.id);
    const free = jobs.length < MAX_WALKERS && !jobs.some((j) => j.walker === walker.id);
    if (reduced || from === undefined || to === undefined || !free || from === to) {
      if (seats.has(speaker.id)) say(speaker.id, text, now, reduced ? REDUCED_BUBBLE_MS : HOLD_MS);
      return;
    }
    const out = walkRoute({ seat: from, at: "seat" }, { seat: to, at: "visit" });
    const back = walkRoute({ seat: to, at: "visit" }, { seat: from, at: "seat" });
    const outMs = (routeLength(out) / WALK_SPEED) * 1000;
    const backMs = (routeLength(back) / WALK_SPEED) * 1000;
    jobs.push({ walker: walker.id, target: target.id, startedAt: now, out, back, outMs, backMs });
    // The speaker talks from the moment the visitor arrives until just before the walk home.
    put(speaker.id, { text: shorten(text), from: now + outMs, until: now + outMs + HOLD_MS });
  }

  function observe(agents: readonly Agent[], seats: ReadonlyMap<string, number>, now: number, { reduced, frozen }: ObserveOptions) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const next = new Map<string, Remembered>();
    for (const a of agents) next.set(a.id, { status: a.status, task: a.currentTask, activity: a.activity });

    // A whole new list (demo switched on or off, the list emptied and filled again) is a new starting
    // point, not news: nobody walks because of it.
    if (agents.length === 0 || (known.size > 0 && !agents.some((a) => known.has(a.id)))) {
      known = next;
      started = agents.length > 0;
      jobs = [];
      speech = new Map();
      lastTool.clear();
      return;
    }
    if (reduced) jobs = []; // asking for less motion mid-walk sends everyone home at once

    // Anyone who left takes their walks and words with them.
    jobs = jobs.filter((j) => byId.has(j.walker) && byId.has(j.target));
    for (const id of [...speech.keys()]) if (!byId.has(id)) speech.delete(id);
    for (const id of [...lastTool.keys()]) if (!byId.has(id)) lastTool.delete(id);

    if (frozen) {
      jobs = [];
      speech = new Map();
    } else if (started) {
      for (const a of agents) {
        const before = known.get(a.id);
        const parent = a.parentId === null ? undefined : byId.get(a.parentId);
        if (parent && a.currentTask && (before === undefined || a.currentTask !== before.task)) {
          visit(parent, a, seats, a.currentTask, a, now, reduced);
        } else if (parent && before && isFinished(a.status) && !isFinished(before.status)) {
          visit(a, parent, seats, a.note ?? a.activity ?? a.status, a, now, reduced);
        } else if (before && a.status === "working" && a.activity && a.activity !== before.activity && seats.has(a.id)) {
          // A tool bubble never replaces words that are still waiting to be heard or are being heard.
          if (now - (lastTool.get(a.id) ?? -Infinity) >= TOOL_BUBBLE_EVERY_MS && (speech.get(a.id)?.until ?? 0) <= now) {
            lastTool.set(a.id, now);
            say(a.id, a.tool ? `${a.tool}: ${a.activity}` : a.activity, now, reduced ? REDUCED_BUBBLE_MS : TOOL_BUBBLE_MS);
          }
        }
      }
    }
    known = next;
    if (agents.length > 0) started = true; // the first picture is the starting point, not news
  }

  /** Who is walking where, and who is saying what, at this moment. Also forgets what is over. */
  function frame(now: number): StoryFrame {
    const walkers: Walker[] = [];
    jobs = jobs.filter((j) => now - j.startedAt < j.outMs + HOLD_MS + j.backMs);
    for (const j of jobs) {
      const t = now - j.startedAt;
      if (t < j.outMs) walkers.push({ agentId: j.walker, ...pointAlong(j.out, (t / 1000) * WALK_SPEED), moving: true });
      else if (t < j.outMs + HOLD_MS) {
        const end = j.out.at(-1) as Point;
        walkers.push({ agentId: j.walker, ...end, heading: pointAlong(j.out, Infinity).heading, moving: false });
      } else walkers.push({ agentId: j.walker, ...pointAlong(j.back, ((t - j.outMs - HOLD_MS) / 1000) * WALK_SPEED), moving: true });
    }
    const bubbles: Bubble[] = [];
    for (const [agentId, s] of speech) {
      if (now >= s.until) speech.delete(agentId);
      else if (now >= s.from) bubbles.push({ agentId, text: s.text });
    }
    return { walkers, bubbles };
  }

  return { observe, frame };
}

export type Story = ReturnType<typeof createStory>;
