// What the characters do between themselves, worked out from the agents the page already has: a master
// walks to a worker to hand it a task (to the Meeting room with several workers at once), a worker walks to
// its master to report, an agent that has been idle for a while takes a break in the Pantry or the Lounge,
// and working agents now and then say what they are doing. No clock of its own: the caller passes the time in milliseconds.
import type { Agent, AgentStatus } from "../../../shared/events.ts";
import { LOUNGE_KEY, MEETING_KEY, PANTRY_KEY, type Building } from "./building.ts";
import { hashId } from "./palette.ts";
import { placeRoute, pointAlong, routeLength, walkRoute, WALK_SPEED, type Place, type Point } from "./walk.ts";

export const MAX_WALKERS = 4;
export const MAX_BUBBLES = 4;
export const HOLD_MS = 2500;
export const TOOL_BUBBLE_EVERY_MS = 8000;
export const TOOL_BUBBLE_MS = 3500;
export const REDUCED_BUBBLE_MS = 2000;
export const MAX_TEXT = 80;
export const IDLE_BEFORE_BREAK_MS = 30_000;
export const BREAK_HOLD_MS = 8000;
export const BREAK_COOLDOWN_MS = 120_000;
export const KICKOFF_HOLD_MS = 6000;
/** The master and up to three of its workers go to a kick-off. */
export const MAX_KICKOFF = 4;

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
  /** The agent walked to (a desk visit); null for a trip to a shared room. */
  target: string | null;
  kind: "visit" | "break" | "kickoff";
  /** How long the walker stands at the far end. */
  hold: number;
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
  /** Where the desks and doors are: walks follow it. */
  building: Building;
};

export function createStory() {
  let known = new Map<string, Remembered>();
  let started = false;
  let jobs: Job[] = [];
  let speech = new Map<string, Speech>();
  const lastTool = new Map<string, number>();
  const idleSince = new Map<string, number>();
  const lastBreak = new Map<string, number>();
  let ctx: { seats: ReadonlyMap<string, number>; building: Building; reduced: boolean; frozen: boolean } | null = null;

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
  function visit(building: Building, walker: Agent, target: Agent, seats: ReadonlyMap<string, number>, text: string, speaker: Agent, now: number, reduced: boolean) {
    const from = seats.get(walker.id);
    const to = seats.get(target.id);
    const free = jobs.length < MAX_WALKERS && !jobs.some((j) => j.walker === walker.id);
    if (reduced || from === undefined || to === undefined || !free || from === to) {
      if (seats.has(speaker.id)) say(speaker.id, text, now, reduced ? REDUCED_BUBBLE_MS : HOLD_MS);
      return;
    }
    const out = walkRoute(building, { seat: from, at: "seat" }, { seat: to, at: "visit" });
    const back = walkRoute(building, { seat: to, at: "visit" }, { seat: from, at: "seat" });
    if (out.length === 0 || back.length === 0) return;
    const outMs = (routeLength(out) / WALK_SPEED) * 1000;
    const backMs = (routeLength(back) / WALK_SPEED) * 1000;
    jobs.push({ walker: walker.id, target: target.id, kind: "visit", hold: HOLD_MS, startedAt: now, out, back, outMs, backMs });
    // The speaker talks from the moment the visitor arrives until just before the walk home.
    put(speaker.id, { text: shorten(text), from: now + outMs, until: now + outMs + HOLD_MS });
  }

  /** A trip from a seat to a place in a shared room and (the same way, reversed) home again. Null when there is no seat or no route. */
  function goTo(building: Building, id: string, seats: ReadonlyMap<string, number>, place: Place, now: number, kind: "break" | "kickoff", hold: number): Job | null {
    const seat = seats.get(id);
    const out = seat === undefined ? [] : placeRoute(building, { seat, at: "seat" }, place);
    if (out.length === 0) return null;
    const ms = (routeLength(out) / WALK_SPEED) * 1000;
    const job: Job = { walker: id, target: null, kind, hold, startedAt: now, out, back: [...out].reverse(), outMs: ms, backMs: ms };
    jobs.push(job);
    return job;
  }

  /** The master and some of its new workers meet round the table in the Meeting room; the master's words are the first task. False when they cannot all go. */
  function kickoff(building: Building, master: Agent, workers: readonly Agent[], seats: ReadonlyMap<string, number>, now: number): boolean {
    const group = [master, ...workers.slice(0, MAX_KICKOFF - 1)];
    if (jobs.length + group.length > MAX_WALKERS || group.some((a) => !seats.has(a.id) || jobs.some((j) => j.walker === a.id))) return false;
    const made = group.map((a, spot) => goTo(building, a.id, seats, { room: MEETING_KEY, spot }, now, "kickoff", KICKOFF_HOLD_MS));
    if (made.some((j) => j === null)) {
      jobs = jobs.filter((j) => !made.includes(j));
      return false;
    }
    // They arrive one by one and leave together: everyone stands until the last has been there for the kick-off time.
    const all = made as Job[];
    const together = Math.max(...all.map((j) => j.outMs));
    for (const j of all) j.hold = together - j.outMs + KICKOFF_HOLD_MS;
    put(master.id, { text: shorten(`Kick-off: ${workers[0]?.currentTask ?? ""}`), from: now + together, until: now + together + KICKOFF_HOLD_MS });
    return true;
  }

  /** Sends the agent that has been idle longest to the Pantry or the Lounge, if one is due and nobody else is on a break. */
  function startBreak(now: number) {
    if (!ctx || ctx.reduced || ctx.frozen || jobs.some((j) => j.kind === "break") || jobs.length >= MAX_WALKERS - 1) return; // a task visit keeps its place
    const { seats, building } = ctx;
    const walking = new Set(jobs.map((j) => j.walker));
    const due = [...idleSince]
      .filter(([id, since]) => now - since >= IDLE_BEFORE_BREAK_MS && seats.has(id) && !walking.has(id) && now - (lastBreak.get(id) ?? -Infinity) >= BREAK_COOLDOWN_MS)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (const [id] of due) {
      const job = goTo(building, id, seats, { room: hashId(id) % 2 === 0 ? PANTRY_KEY : LOUNGE_KEY, spot: 3 }, now, "break", BREAK_HOLD_MS);
      if (!job) continue;
      lastBreak.set(id, now);
      put(id, { text: "Taking a break", from: now + job.outMs, until: now + job.outMs + BREAK_HOLD_MS });
      return;
    }
  }

  function observe(agents: readonly Agent[], seats: ReadonlyMap<string, number>, now: number, { reduced, frozen, building }: ObserveOptions) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    ctx = { seats, building, reduced, frozen };
    // Who has been idle since when: an agent is "idle" from the first update that says so until one that does not.
    for (const id of [...idleSince.keys()]) if (byId.get(id)?.status !== "idle") idleSince.delete(id);
    for (const a of agents) if (a.status === "idle" && !idleSince.has(a.id)) idleSince.set(a.id, now);
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
      lastBreak.clear();
      return;
    }
    if (reduced) {
      // Asking for less motion mid-walk sends everyone home at once, and a break that is no longer happening must not be announced.
      for (const j of jobs) if (j.kind === "break") speech.delete(j.walker);
      jobs = [];
    }

    // Anyone who left takes their walks and words with them.
    jobs = jobs.filter((j) => byId.has(j.walker) && (j.target === null || byId.has(j.target)));
    // A break ends the moment the agent is no longer idle, or is given a task: it is back at its desk at once.
    const endsBreak = (id: string) => {
      const a = byId.get(id);
      return !a || a.status !== "idle" || (known.has(id) && a.currentTask !== known.get(id)?.task);
    };
    for (const j of jobs) if (j.kind === "break" && endsBreak(j.walker)) speech.delete(j.walker);
    jobs = jobs.filter((j) => j.kind !== "break" || !endsBreak(j.walker));
    for (const id of [...lastBreak.keys()]) if (!byId.has(id)) lastBreak.delete(id);
    for (const id of [...speech.keys()]) if (!byId.has(id)) speech.delete(id);
    for (const id of [...lastTool.keys()]) if (!byId.has(id)) lastTool.delete(id);

    if (frozen) {
      jobs = [];
      speech = new Map();
    } else if (started) {
      // Workers that were just given a task, by master: two or more at once go to the Meeting room with their master.
      const fresh = new Map<string, Agent[]>();
      for (const a of agents) {
        const parent = a.parentId === null ? undefined : byId.get(a.parentId);
        const before = known.get(a.id);
        if (parent && a.currentTask && (before === undefined || a.currentTask !== before.task)) fresh.set(parent.id, [...(fresh.get(parent.id) ?? []), a]);
      }
      const kickedOff = new Set<string>();
      if (!reduced) {
        for (const [masterId, workers] of fresh) {
          const master = byId.get(masterId);
          if (master && workers.length >= 2 && kickoff(building, master, workers, seats, now)) for (const w of workers.slice(0, MAX_KICKOFF - 1)) kickedOff.add(w.id);
        }
      }
      for (const a of agents) {
        const before = known.get(a.id);
        const parent = a.parentId === null ? undefined : byId.get(a.parentId);
        if (parent && a.currentTask && (before === undefined || a.currentTask !== before.task)) {
          if (!kickedOff.has(a.id)) visit(building, parent, a, seats, a.currentTask, a, now, reduced);
        } else if (parent && before && isFinished(a.status) && !isFinished(before.status)) {
          visit(building, a, parent, seats, a.note ?? a.activity ?? a.status, a, now, reduced);
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
    startBreak(now);
    jobs = jobs.filter((j) => now - j.startedAt < j.outMs + j.hold + j.backMs);
    for (const j of jobs) {
      const t = now - j.startedAt;
      if (t < j.outMs) walkers.push({ agentId: j.walker, ...pointAlong(j.out, (t / 1000) * WALK_SPEED), moving: true });
      else if (t < j.outMs + j.hold) {
        const end = j.out.at(-1) as Point;
        walkers.push({ agentId: j.walker, ...end, heading: pointAlong(j.out, Infinity).heading, moving: false });
      } else walkers.push({ agentId: j.walker, ...pointAlong(j.back, ((t - j.outMs - j.hold) / 1000) * WALK_SPEED), moving: true });
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
