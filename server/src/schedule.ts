import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { realOps, renameWithRetry, type WriteOps } from "./managedStore.ts";

// Opt-in scheduled research sweeps. The setting lives in one file in the data folder and only works while
// the server runs. A sweep started here is the same sweep the button starts: same prompt, same caps.

export const SCHEDULE_FILE = "research-schedule.json";
export const TICK_MS = 5 * 60_000;
export const NEAR_CAP_FRACTION = 0.8;
export const MODES = ["off", "daily", "weekly"] as const;
export type Mode = (typeof MODES)[number];
const INTERVAL_MS: Record<Exclude<Mode, "off">, number> = { daily: 24 * 3_600_000, weekly: 7 * 24 * 3_600_000 };

const Iso = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)));
const ScheduleFile = z
  .object({
    version: z.literal(1),
    mode: z.enum(MODES),
    lastRunAt: Iso.nullable(),
    lastSkipped: z.object({ reason: z.string().min(1).max(60), at: Iso }).strict().nullable(),
  })
  .strict();
export type Schedule = Omit<z.infer<typeof ScheduleFile>, "version">;
export const ModeBody = z.object({ mode: z.enum(MODES) }).strict();

const DEFAULT: Schedule = { mode: "off", lastRunAt: null, lastSkipped: null };

/** The schedule file: strict shape, atomic writes (temporary file, then rename), a damaged file is set aside as `.bad` and reads as off. */
export function createScheduleStore(dir: string, ops: WriteOps = realOps) {
  const file = join(dir, SCHEDULE_FILE);
  let current: Promise<Schedule> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const load = () =>
    (current ??= (async (): Promise<Schedule> => {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return { ...DEFAULT };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      const parsed = ScheduleFile.safeParse(raw);
      if (!parsed.success) {
        await rename(file, `${file}.bad`).catch(() => {});
        return { ...DEFAULT };
      }
      const { mode, lastRunAt, lastSkipped } = parsed.data;
      return { mode, lastRunAt, lastSkipped };
    })());

  async function save(next: Schedule) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await ops.writeFile(tmp, JSON.stringify({ version: 1, ...next }));
      await renameWithRetry(ops, tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  return {
    get: () => enqueue(async () => ({ ...(await load()) })),
    /** Applies `change` to the stored schedule and saves it. The cache only moves on after the write worked. */
    update: (change: (s: Schedule) => Schedule) =>
      enqueue(async () => {
        const next = change({ ...(await load()) });
        await save(next);
        current = Promise.resolve(next);
        return { ...next };
      }),
  };
}
export type ScheduleStore = ReturnType<typeof createScheduleStore>;

export type ScheduleView = Schedule & { nextRunAt: string | null };

type SweepStart = { ok: true } | { ok: false; code: string };

export type SchedulerOptions = {
  store: ScheduleStore;
  /** Starts a sweep exactly like the manual route does. */
  startSweep: () => Promise<SweepStart>;
  usage: () => { totalUsd: number; caps: { totalUsd: number } };
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => { unref(): unknown };
  clearInterval?: (timer: never) => void;
  log?: (line: Record<string, unknown>) => void;
};

export function createScheduler(opts: SchedulerOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const setTimer = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = (opts.clearInterval ?? clearInterval) as (timer: unknown) => void;
  let timer: { unref(): unknown } | undefined;
  let ticking: Promise<void> | undefined;
  let lastStartedAt = 0;
  let closed = false;

  const view = (s: Schedule): ScheduleView => ({
    ...s,
    nextRunAt: s.mode === "off" || s.lastRunAt === null ? null : new Date(Date.parse(s.lastRunAt) + INTERVAL_MS[s.mode]).toISOString(),
  });

  async function skip(reason: string) {
    const at = new Date(now()).toISOString();
    await opts.store.update((s) => ({ ...s, lastSkipped: { reason, at } }));
    log({ event: "sweep-skipped", reason });
  }

  async function runTick() {
    const s = await opts.store.get();
    if (s.mode === "off") return;
    if (s.lastRunAt === null) {
      await opts.store.update((x) => ({ ...x, lastRunAt: new Date(now()).toISOString() }));
      return;
    }
    // lastStartedAt keeps a failed restore from letting a second sweep start inside the same interval.
    const last = Math.max(Date.parse(s.lastRunAt), lastStartedAt);
    if (now() - last < INTERVAL_MS[s.mode]) return;
    const { totalUsd, caps } = opts.usage();
    if (totalUsd >= caps.totalUsd * NEAR_CAP_FRACTION) return skip("near_cap");
    if (closed) return;
    // Claim the interval before spending: if this write fails nothing is started.
    const previous = s.lastRunAt;
    const claimedAt = now();
    await opts.store.update((x) => ({ ...x, lastRunAt: new Date(claimedAt).toISOString(), lastSkipped: null }));
    lastStartedAt = claimedAt;
    const refused: SweepStart = closed ? { ok: false, code: "closed" } : await opts.startSweep().catch((error: unknown) => {
      log({ event: "schedule-error", message: error instanceof Error ? error.message : "unknown" });
      return { ok: false as const, code: "error" };
    });
    if (refused.ok) {
      log({ event: "sweep-scheduled" });
      return;
    }
    const at = new Date(now()).toISOString();
    log({ event: "sweep-skipped", reason: refused.code });
    try {
      await opts.store.update((x) => ({ ...x, lastRunAt: previous, lastSkipped: { reason: refused.code, at } }));
      lastStartedAt = 0;
    } catch {
      log({ event: "schedule-error", message: "restore failed" });
    }
  }

  /** One check. A tick that arrives while another is still running does nothing. Never throws. */
  function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = runTick()
      .catch(async (error: unknown) => {
        log({ event: "schedule-error", message: error instanceof Error ? error.message : "unknown" });
        await skip("error").catch(() => {});
      })
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  return {
    tick,
    start() {
      timer ??= setTimer(() => void tick(), TICK_MS);
      timer.unref();
    },
    async view(): Promise<ScheduleView> {
      return view(await opts.store.get());
    },
    /** Turning it on from off starts the clock now, so enabling never runs a sweep at once. */
    async setMode(mode: Mode): Promise<ScheduleView> {
      return view(
        await opts.store.update((s) => ({
          ...s,
          mode,
          lastRunAt: s.mode === "off" && mode !== "off" ? new Date(now()).toISOString() : s.lastRunAt,
          lastSkipped: null,
        })),
      );
    },
    async close() {
      closed = true;
      if (timer) clearTimer(timer);
      timer = undefined;
      await ticking;
    },
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
