import { spawn } from "node:child_process";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createChannel } from "./channel.ts";
import { buildChildEnv } from "./childEnv.ts";
import { folderGuardHooks } from "./folderGuard.ts";
import { killTree as defaultKillTree } from "./killTree.ts";
import { lockdownOptions } from "./lockdown.ts";
import { resolveAllowedFolder } from "./paths.ts";
import type { Registry } from "./registry.ts";
import { clean, parseValue } from "./transcript.ts";

/** The SDK's `query` function. Passed in so tests can use a scripted stand-in. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export type StartRequest = { cwd: string; prompt: string; name?: string };
export type StartResult =
  | { ok: true; id: string }
  | { ok: false; status: 400 | 403 | 429 | 502; code: "invalid_folder" | "folder_not_allowed" | "too_many" | "start_failed" };

export type SupervisorOptions = {
  registry: Registry;
  query: QueryFn;
  roots: string[];
  env: Record<string, string | undefined>;
  maxManaged?: number;
  /** How long a polite stop may take before the process tree is killed. */
  stopGraceMs?: number;
  /** How long to wait for a session to report its id. */
  startTimeoutMs?: number;
  /** How long an ended worker stays in the list. Keep it at least as long as the log watcher's stale window. */
  forgetAfterMs?: number;
  killTree?: (pid: number) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
};

type Managed = {
  id: string | null;
  input: ReturnType<typeof createChannel<SDKUserMessage>>;
  abort: AbortController;
  query: Query | null;
  pid: number | null;
  exited: boolean;
  state: "starting" | "running" | "stopping" | "ended";
  stopRequested: boolean;
  /** The stream threw. */
  failed: boolean;
  /** The session was not on the subscription login. */
  refused: boolean;
  done: Promise<void>;
  resolveId: (id: string) => void;
  rejectId: (error: Error) => void;
  idReady: Promise<string>;
};

export function createSupervisor(opts: SupervisorOptions) {
  const { registry, roots, env } = opts;
  const maxManaged = opts.maxManaged ?? 6;
  const stopGraceMs = opts.stopGraceMs ?? 10_000;
  const startTimeoutMs = opts.startTimeoutMs ?? 30_000;
  const forgetAfterMs = opts.forgetAfterMs ?? 16 * 60_000;
  const killTree = opts.killTree ?? defaultKillTree;
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));

  const all = new Set<Managed>(); // every worker that has not been forgotten
  const byId = new Map<string, Managed>();
  const timers = new Set<NodeJS.Timeout>();

  const live = () => [...all].filter((m) => m.state !== "ended");

  function spawnTracked(m: Managed, o: Parameters<NonNullable<Options["spawnClaudeCodeProcess"]>>[0]) {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      signal: o.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32", // own process group, so the whole tree can be killed
    });
    m.pid = child.pid ?? null;
    child.stderr?.resume(); // nobody reads it, but an unread pipe can block the child
    child.once("exit", () => {
      m.exited = true;
    });
    child.on("error", (error) => log({ event: "managed-process-error", message: error.message }));
    return child;
  }

  function finalize(m: Managed, status: "stopped" | "error") {
    if (m.state === "ended") return;
    m.state = "ended";
    if (m.id) {
      const id = m.id;
      registry.setTerminal(id, status);
      const timer = setTimeout(() => {
        timers.delete(timer);
        registry.remove(id);
        byId.delete(id);
        all.delete(m);
      }, forgetAfterMs);
      timer.unref();
      timers.add(timer);
    } else {
      all.delete(m);
      m.rejectId(new Error("ended before the session started"));
    }
  }

  function handle(m: Managed, message: SDKMessage, req: StartRequest, project: string) {
    if (message.type === "system" && message.subtype === "init") {
      // The init message can repeat, and its key source is checked every time.
      if (message.apiKeySource !== "none") {
        log({ event: "managed-refused", reason: "api_key_source", source: String(message.apiKeySource) });
        m.refused = true;
        m.rejectId(new Error("session is not on the subscription login"));
        void terminate(m);
        return;
      }
      if (m.id === null) {
        const id = message.session_id;
        m.id = id;
        m.state = "running";
        byId.set(id, m);
        registry.upsert(id, {
          kind: "session",
          origin: "managed",
          role: "worker",
          parentId: null,
          project,
          name: req.name ? clean(req.name) : "Worker",
          currentTask: clean(req.prompt),
        });
        log({ event: "managed-session", id, tools: Array.isArray(message.tools) ? message.tools : [] });
        m.resolveId(id);
      }
      return;
    }
    if (m.id === null) return;
    if (message.type === "assistant" || message.type === "user") {
      const parsed = parseValue(message);
      if (parsed.ok) registry.apply(m.id, parsed.facts, null);
    } else if (message.type === "result") {
      registry.apply(m.id, [{ kind: "event" }], null);
      log({ event: "managed-turn-end", id: m.id, subtype: message.subtype });
    }
  }

  async function consume(m: Managed, req: StartRequest, project: string) {
    try {
      for await (const message of m.query as Query) {
        if (m.state === "ended") break;
        handle(m, message, req, project);
      }
    } catch (error) {
      m.failed = true;
      log({ event: "managed-error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      // A failure that happens while we are already stopping it is just part of stopping.
      finalize(m, m.refused || (m.failed && !m.stopRequested) ? "error" : "stopped");
      if (m.pid !== null && !m.exited) await killTree(m.pid); // never leave a process behind
    }
  }

  async function terminate(m: Managed) {
    if (m.state === "ended") return;
    m.stopRequested = true;
    if (m.state !== "starting") m.state = "stopping";
    // Polite first: interrupt the turn and close the input so the session ends by itself.
    void m.query?.interrupt().catch(() => {});
    m.input.close();
    if (await within(m.done, stopGraceMs)) return;
    log({ event: "managed-forced-stop", id: m.id });
    // Kill the tree first, while the parent still exists, so its children can be found.
    if (m.pid !== null && !m.exited) await killTree(m.pid); // not after it exited: the id could be reused
    m.abort.abort();
    await within(m.done, 2000);
    finalize(m, "stopped"); // in case the stream never finished
  }

  return {
    async start(req: StartRequest): Promise<StartResult> {
      const folder = await resolveAllowedFolder(req.cwd, roots);
      if (!folder.ok) {
        const refused = folder.reason === "outside_roots";
        log({ event: "managed-refused", reason: folder.reason });
        return refused
          ? { ok: false, status: 403, code: "folder_not_allowed" }
          : { ok: false, status: 400, code: "invalid_folder" };
      }
      // No await between this check and adding the worker, so two starts cannot both pass.
      if (live().length >= maxManaged) {
        log({ event: "managed-refused", reason: "too_many" });
        return { ok: false, status: 429, code: "too_many" };
      }

      let resolveId!: (id: string) => void;
      let rejectId!: (error: Error) => void;
      const idReady = new Promise<string>((resolve, reject) => {
        resolveId = resolve;
        rejectId = reject;
      });
      idReady.catch(() => {}); // the caller handles it; this stops an unhandled-rejection warning
      const m: Managed = {
        id: null,
        input: createChannel<SDKUserMessage>(),
        abort: new AbortController(),
        query: null,
        pid: null,
        exited: false,
        state: "starting",
        stopRequested: false,
        failed: false,
        refused: false,
        done: Promise.resolve(),
        resolveId,
        rejectId,
        idReady,
      };
      all.add(m);

      const project = clean(folder.path.split(/[\\/]/).filter(Boolean).pop() ?? "") || "unknown";
      m.input.push({ type: "user", message: { role: "user", content: req.prompt }, parent_tool_use_id: null });
      try {
        m.query = opts.query({
          prompt: m.input.iterable,
          options: {
            ...lockdownOptions(),
            // Keeps every file tool inside this folder; permission rules alone would allow any path.
            hooks: folderGuardHooks(folder.path, (tool, reason) => log({ event: "managed-tool-denied", tool, reason })),
            cwd: folder.path,
            env: buildChildEnv(env),
            abortController: m.abort,
            spawnClaudeCodeProcess: (o) => spawnTracked(m, o),
          },
        });
      } catch (error) {
        all.delete(m);
        log({ event: "managed-error", message: error instanceof Error ? error.message : String(error) });
        return { ok: false, status: 502, code: "start_failed" };
      }
      m.done = consume(m, req, project);

      try {
        const id = await withTimeout(m.idReady, startTimeoutMs);
        log({ event: "managed-start", id });
        return { ok: true, id };
      } catch {
        await terminate(m);
        finalize(m, "error");
        all.delete(m);
        return { ok: false, status: 502, code: "start_failed" };
      }
    },

    /** Ends one worker. Resolves when it has ended, by force if it had to. */
    async stop(id: string): Promise<"ok" | "not_found"> {
      const m = byId.get(id);
      if (!m) return "not_found";
      await terminate(m);
      return "ok";
    },

    async stopAll(): Promise<void> {
      await Promise.all(live().map(terminate));
    },

    /** True for every worker this app started (also after it ended), so the log watcher skips it. */
    claims: (id: string) => byId.has(id),
    /** True while a worker is waiting for its session id, which is when a new log file could be its own. */
    starting: () => [...all].some((m) => m.state === "starting"),
    liveCount: () => live().length,

    async close() {
      await Promise.all(live().map(terminate));
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;

/** Resolves true if the promise settles within `ms`, false if the time runs out first. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
