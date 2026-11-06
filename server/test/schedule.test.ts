import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer } from "../src/app.ts";
import { ensureResearchLayout } from "../src/findings.ts";
import { createScheduleStore, createScheduler, SCHEDULE_FILE, TICK_MS } from "../src/schedule.ts";
import { loginTo, send } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((c) => c()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "schedule-")));
  dirs.push(d);
  return d;
};

type Start = { ok: true } | { ok: false; code: string };
function unit(opts: { totalUsd?: number; capUsd?: number; dir?: string } = {}) {
  const dir = opts.dir ?? tmp();
  const clock = { t: T0 };
  const logs: Record<string, unknown>[] = [];
  const state = { calls: 0, next: (): Promise<Start> => Promise.resolve({ ok: true }), totalUsd: opts.totalUsd ?? 0 };
  const timers: { fn: () => void; ms: number; unrefed: boolean; cleared: boolean }[] = [];
  const real = createScheduleStore(dir);
  // failing: the next update calls (counted from 1) that reject, for example [1] = the claim, [2] = the restore.
  const writes = { n: 0, failing: [] as number[], hold: undefined as Promise<void> | undefined };
  const store: typeof real = {
    get: real.get,
    update: async (change) => {
      if (writes.failing.includes(++writes.n)) throw new Error("disk full");
      await writes.hold;
      return real.update(change);
    },
  };
  const scheduler = createScheduler({
    store,
    startSweep: () => {
      state.calls++;
      return state.next();
    },
    usage: () => ({ totalUsd: state.totalUsd, caps: { totalUsd: opts.capUsd ?? 20 } }),
    now: () => clock.t,
    log: (l) => logs.push(l),
    setInterval: (fn, ms) => {
      const t = { fn, ms, unrefed: false, cleared: false };
      timers.push(t);
      return Object.assign(t, { unref: () => void (t.unrefed = true) });
    },
    clearInterval: ((h: { cleared: boolean }) => void (h.cleared = true)) as never,
  });
  return { dir, clock, logs, state, timers, store, scheduler, writes };
}

describe("schedule: when it runs", () => {
  it("defaults to off and never runs", async () => {
    const u = unit();
    assert.deepEqual(await u.scheduler.view(), { mode: "off", lastRunAt: null, lastSkipped: null, nextRunAt: null });
    u.clock.t += 30 * 24 * HOUR;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
    assert.equal((await u.scheduler.view()).lastRunAt, null);
    await u.scheduler.setMode("daily");
    await u.scheduler.setMode("off");
    u.clock.t += 30 * 24 * HOUR;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
  });

  it("does not run at once when enabled, runs once when a day has passed, then waits again", async () => {
    const u = unit();
    const v = await u.scheduler.setMode("daily");
    assert.deepEqual([v.lastRunAt, v.nextRunAt], [new Date(T0).toISOString(), new Date(T0 + 24 * HOUR).toISOString()]);
    await u.scheduler.tick();
    u.clock.t += 24 * HOUR - 1;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
    u.clock.t += 1;
    await u.scheduler.tick();
    await u.scheduler.tick();
    assert.equal(u.state.calls, 1);
    const done = await u.scheduler.view();
    assert.equal(done.lastRunAt, new Date(u.clock.t).toISOString());
    assert.equal(done.nextRunAt, new Date(u.clock.t + 24 * HOUR).toISOString());
  });

  it("weekly waits seven days", async () => {
    const u = unit();
    await u.scheduler.setMode("weekly");
    u.clock.t += 7 * 24 * HOUR - 1;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
    u.clock.t += 1;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 1);
  });

  it("switching between daily and weekly keeps the clock; off then on restarts it; off clears nextRunAt", async () => {
    const u = unit();
    await u.scheduler.setMode("daily");
    u.clock.t += 2 * HOUR;
    assert.equal((await u.scheduler.setMode("weekly")).lastRunAt, new Date(T0).toISOString());
    assert.equal((await u.scheduler.setMode("off")).nextRunAt, null);
    assert.equal((await u.scheduler.setMode("daily")).lastRunAt, new Date(T0 + 2 * HOUR).toISOString());
  });

  it("starts the clock instead of running when the file says on but has never run", async () => {
    const dir = tmp();
    writeFileSync(join(dir, SCHEDULE_FILE), JSON.stringify({ version: 1, mode: "daily", lastRunAt: null, lastSkipped: null }));
    const u = unit({ dir });
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
    assert.equal((await u.scheduler.view()).lastRunAt, new Date(T0).toISOString());
  });
});

describe("schedule: skipping", () => {
  async function due() {
    const u = unit();
    await u.scheduler.setMode("daily");
    u.clock.t += 24 * HOUR;
    return u;
  }

  for (const code of ["sweep_running", "master_running", "budget"]) {
    it(`skips on ${code}, keeps lastRunAt, logs, and retries on the next tick`, async () => {
      const u = await due();
      const lastRunAt = (await u.scheduler.view()).lastRunAt;
      u.state.next = () => Promise.resolve({ ok: false, code });
      await u.scheduler.tick();
      const skipped = await u.scheduler.view();
      assert.deepEqual(skipped.lastSkipped, { reason: code, at: new Date(u.clock.t).toISOString() });
      assert.equal(skipped.lastRunAt, lastRunAt);
      assert.deepEqual(u.logs.filter((l) => l["event"] === "sweep-skipped"), [{ event: "sweep-skipped", reason: code }]);
      u.clock.t += TICK_MS;
      u.state.next = () => Promise.resolve({ ok: true });
      await u.scheduler.tick();
      assert.equal(u.state.calls, 2);
      const done = await u.scheduler.view();
      assert.equal(done.lastSkipped, null);
      assert.equal(done.lastRunAt, new Date(u.clock.t).toISOString());
    });
  }

  it("skips without asking the supervisor when the app total is at 80% of its cap, and runs just below", async () => {
    const u = unit({ totalUsd: 16, capUsd: 20 });
    await u.scheduler.setMode("daily");
    u.clock.t += 24 * HOUR;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
    assert.equal((await u.scheduler.view()).lastSkipped?.reason, "near_cap");
    u.state.totalUsd = 15.99;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 1);
  });

  it("survives a failing start: records the skip and does not throw", async () => {
    const u = await due();
    u.state.next = () => Promise.reject(new Error("boom"));
    await u.scheduler.tick();
    assert.equal((await u.scheduler.view()).lastSkipped?.reason, "error");
    assert.ok(u.logs.some((l) => l["event"] === "schedule-error"));
  });

  it("claims the interval before spending: a failing claim write starts nothing", async () => {
    const u = await due();
    u.writes.failing = [u.writes.n + 1];
    await u.scheduler.tick();
    assert.equal(u.state.calls, 0);
    u.clock.t += TICK_MS;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 1, "a later tick can still run");
  });

  it("persists the claim before the sweep starts", async () => {
    const u = await due();
    let seen: string | null = null;
    u.state.next = async () => {
      seen = (await u.store.get()).lastRunAt;
      return { ok: true };
    };
    await u.scheduler.tick();
    assert.equal(seen, new Date(u.clock.t).toISOString());
  });

  it("a thrown start restores the previous lastRunAt", async () => {
    const u = await due();
    const before = (await u.scheduler.view()).lastRunAt;
    u.state.next = () => Promise.reject(new Error("boom"));
    await u.scheduler.tick();
    assert.equal((await u.scheduler.view()).lastRunAt, before);
  });

  it("a failed restore after a refusal still never repeats inside the interval", async () => {
    const u = await due();
    u.state.next = () => Promise.resolve({ ok: false, code: "sweep_running" });
    u.writes.failing = [u.writes.n + 2];
    await u.scheduler.tick();
    for (let i = 0; i < 5; i++) {
      u.clock.t += TICK_MS;
      u.state.next = () => Promise.resolve({ ok: true });
      await u.scheduler.tick();
    }
    assert.equal(u.state.calls, 1);
  });

  it("runs one tick at a time", async () => {
    const u = await due();
    let release: (r: Start) => void = () => {};
    u.state.next = () => new Promise((r) => (release = r));
    const first = u.scheduler.tick();
    const second = u.scheduler.tick();
    while (u.state.calls === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(u.state.calls, 1);
    release({ ok: true });
    await Promise.all([first, second]);
    await u.scheduler.tick();
    assert.equal(u.state.calls, 1, "the finished run moved lastRunAt");
  });
});

describe("schedule: timer", () => {
  it("ticks every 5 minutes on an unref'd timer, starts once, and clears it on close", async () => {
    const u = unit();
    u.scheduler.start();
    u.scheduler.start();
    assert.equal(u.timers.length, 1);
    assert.deepEqual([u.timers[0]?.ms, u.timers[0]?.unrefed], [5 * 60_000, true]);
    await u.scheduler.close();
    assert.equal(u.timers[0]?.cleared, true);
  });

  it("close waits for a running tick and nothing starts after it", async () => {
    const u = unit();
    await u.scheduler.setMode("daily");
    u.clock.t += 24 * HOUR;
    let release: (r: Start) => void = () => {};
    u.state.next = () => new Promise((r) => (release = r));
    void u.scheduler.tick();
    while (u.state.calls === 0) await new Promise((r) => setTimeout(r, 5));
    let closed = false;
    const closing = u.scheduler.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, false);
    release({ ok: true });
    await closing;
    u.clock.t += 30 * 24 * HOUR;
    await u.scheduler.tick();
    assert.equal(u.state.calls, 1);
  });

  it("a close that lands while the claim is being written starts nothing and gives the interval back", async () => {
    const u = unit();
    await u.scheduler.setMode("daily");
    const before = (await u.scheduler.view()).lastRunAt;
    u.clock.t += 24 * HOUR;
    let open: () => void = () => {};
    u.writes.hold = new Promise<void>((r) => (open = r));
    const running = u.scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    const closing = u.scheduler.close();
    u.writes.hold = undefined;
    open();
    await Promise.all([running, closing]);
    assert.equal(u.state.calls, 0);
    assert.equal((await u.scheduler.view()).lastRunAt, before);
  });

  it("the timer fires a tick", async () => {
    const u = unit();
    await u.scheduler.setMode("daily");
    u.clock.t += 24 * HOUR;
    u.scheduler.start();
    u.timers[0]?.fn();
    for (let i = 0; i < 200 && u.state.calls < 1; i++) await new Promise((r) => setTimeout(r, 15)); // slow disks need longer than a fixed wait
    await u.scheduler.close();
    assert.equal(u.state.calls, 1);
  });

  it("the real timer can be started and closed", async () => {
    const s = createScheduler({ store: createScheduleStore(tmp()), startSweep: async () => ({ ok: true }), usage: () => ({ totalUsd: 0, caps: { totalUsd: 1 } }) });
    s.start();
    await s.close();
  });
});

describe("schedule: file", () => {
  it("persists across restarts", async () => {
    const u = unit();
    await u.scheduler.setMode("weekly");
    const again = unit({ dir: u.dir });
    assert.equal((await again.scheduler.view()).mode, "weekly");
    assert.equal(JSON.parse(readFileSync(join(u.dir, SCHEDULE_FILE), "utf8")).version, 1);
  });

  for (const [name, text] of [
    ["not json", "{nope"],
    ["unknown key", JSON.stringify({ version: 1, mode: "daily", lastRunAt: null, lastSkipped: null, extra: 1 })],
    ["bad mode", JSON.stringify({ version: 1, mode: "hourly", lastRunAt: null, lastSkipped: null })],
    ["bad date", JSON.stringify({ version: 1, mode: "daily", lastRunAt: "yesterday", lastSkipped: null })],
    ["wrong version", JSON.stringify({ version: 2, mode: "daily", lastRunAt: null, lastSkipped: null })],
  ] as const) {
    it(`a damaged file (${name}) is set aside as .bad and reads as off`, async () => {
      const dir = tmp();
      writeFileSync(join(dir, SCHEDULE_FILE), text);
      const u = unit({ dir });
      assert.equal((await u.scheduler.view()).mode, "off");
      assert.equal(readFileSync(join(dir, `${SCHEDULE_FILE}.bad`), "utf8"), text);
      u.clock.t += 40 * 24 * HOUR;
      await u.scheduler.tick();
      assert.equal(u.state.calls, 0);
    });
  }
});

describe("schedule routes", () => {
  async function rig(research = true) {
    const root = tmp();
    const dir = join(root, "research");
    const staticDir = join(root, "dist");
    mkdirSync(dir);
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    if (research) await ensureResearchLayout(dir);
    const u = unit({ dir: join(root, "data") });
    const srv = await startServer({ port: 0, staticDir, log: () => {}, scheduler: u.scheduler, ...(research ? { researchDir: dir, dataDir: join(root, "data") } : {}) });
    closers.push(() => srv.close());
    const auth = await loginTo(srv);
    const headers = (more: Record<string, string> = {}) => ({ host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json", ...more });
    return {
      u, srv,
      get: () => send(srv.port, "/api/research/schedule", { headers: { host: auth.host, cookie: auth.cookie } }),
      bare: () => send(srv.port, "/api/research/schedule", { headers: { host: auth.host } }),
      post: (body: unknown, more: Record<string, string> = {}) => send(srv.port, "/api/research/schedule", { method: "POST", headers: headers(more), body: typeof body === "string" ? body : JSON.stringify(body) }),
    };
  }
  const body = (r: { body: string }) => JSON.parse(r.body) as unknown;

  it("GET returns the default and POST switches the mode with the same shape", async () => {
    const r = await rig();
    const first = await r.get();
    assert.deepEqual([first.status, body(first)], [200, { mode: "off", lastRunAt: null, lastSkipped: null, nextRunAt: null }]);
    const on = await r.post({ mode: "daily" });
    const stamp = new Date(T0).toISOString();
    assert.deepEqual([on.status, body(on)], [200, { mode: "daily", lastRunAt: stamp, lastSkipped: null, nextRunAt: new Date(T0 + 24 * HOUR).toISOString() }]);
    assert.deepEqual(body(await r.get()), body(on));
    assert.equal(r.u.state.calls, 0, "enabling does not start a sweep");
    assert.equal((await r.post({ mode: "off" })).status, 200);
  });

  it("refuses a bad body and writes nothing", async () => {
    const r = await rig();
    for (const b of [{}, { mode: "hourly" }, { mode: 1 }, { mode: "daily", extra: 1 }, [], "null", "{bad"]) {
      assert.equal((await r.post(b)).status, 400, JSON.stringify(b));
    }
    assert.equal((await r.post({ mode: "daily" }, { "content-type": "text/plain" })).status, 415);
    assert.equal(existsSync(join(r.u.dir, SCHEDULE_FILE)), false);
  });

  it("needs the session cookie and a same-origin POST", async () => {
    const r = await rig();
    assert.equal((await r.bare()).status, 403);
    assert.equal((await r.post({ mode: "daily" }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await r.u.scheduler.view()).mode, "off");
  });

  it("answers 400 no_research_folder without a research folder", async () => {
    const r = await rig(false);
    for (const res of [await r.get(), await r.post({ mode: "daily" })]) assert.deepEqual([res.status, body(res)], [400, { error: "no_research_folder" }]);
    assert.equal((await r.u.scheduler.view()).mode, "off");
  });
});
