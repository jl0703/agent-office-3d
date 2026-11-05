import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createBudget, DEFAULT_SESSION_BUDGET_USD, DEFAULT_TOTAL_BUDGET_USD, type Cap } from "./budget.ts";
import { createChannel } from "./channel.ts";
import { buildChildEnv } from "./childEnv.ts";
import { folderGuardHooks } from "./folderGuard.ts";
import type { Github } from "./github.ts";
import { createGithubServer, GITHUB_SERVER, GITHUB_TOOL_NAMES } from "./githubTools.ts";
import { killTree as defaultKillTree } from "./killTree.ts";
import { lockdownOptions, MAX_BUDGET_USD, MAX_TURNS } from "./lockdown.ts";
import { cleanTmp, freshOnly, loadStore, saveStore, type StoredWorker } from "./managedStore.ts";
import { createOfficeServer, MASTER_SYSTEM_PROMPT, MAX_RESULT_CHARS, MAX_WAIT_SECONDS, OFFICE_SERVER, OFFICE_TOOL_NAMES, type OfficeApi, type Reply } from "./officeTools.ts";
import { isInside, resolveAllowedFolder } from "./paths.ts";
import { inspectProcess, killLeftovers, type ProcessInfo } from "./processInfo.ts";
import type { Registry } from "./registry.ts";
import { RESEARCH_LEAD_PROMPT, RESEARCHER_PROMPT } from "./research.ts";
import { clean, parseValue } from "./transcript.ts";
import { transcriptActive } from "./transcriptActivity.ts";

/** The SDK's `query` function. Passed in so tests can use a scripted stand-in. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export type StartRequest = { cwd: string; prompt: string; name?: string };
/** A research team's master: the folder is optional and defaults to the research folder. */
export type StartMasterRequest = Omit<StartRequest, "cwd"> & { cwd?: string; team?: "research" };
export type StartResult =
  | { ok: true; id: string }
  | {
      ok: false;
      status: 400 | 403 | 409 | 429 | 502;
      code: "invalid_folder" | "folder_not_allowed" | "too_many" | "start_failed" | "budget" | "master_running" | "worker_limit" | "master_stopped" | "no_research_folder";
    };

export type CommandResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429 | 502;
      /** 409 answers are sent as a `reason`, the others as an `error` code. */
      code: "busy" | "stopped" | "detached" | "not_resumable" | "transcript_active" | "budget" | "too_many" | "invalid_folder" | "folder_not_allowed" | "not_found" | "start_failed";
    };

export const DEFAULT_RESUME_PROMPT = "Continue where you left off.";

const CAP_NOTE: Record<Cap, string> = {
  run: "Stopped: the usage cap for one run was reached.",
  session: "Stopped: the usage cap for this session was reached.",
  total: "Stopped: the usage cap for this server run was reached.",
};

export type SupervisorOptions = {
  registry: Registry;
  query: QueryFn;
  roots: string[];
  env: Record<string, string | undefined>;
  maxManaged?: number;
  /** Masters running at once. */
  maxMasters?: number;
  /** Live workers one master may have. */
  maxWorkersPerMaster?: number;
  /** How long a polite stop may take before the process tree is killed. */
  stopGraceMs?: number;
  /** How long to wait for a session to report its id. */
  startTimeoutMs?: number;
  /** How long an ended worker stays in the list until it is dismissed. */
  forgetAfterMs?: number;
  /** Where the worker file lives. Without it nothing is stored. */
  dataDir?: string;
  /** The Claude log folder, to see whether a conversation is still being written to. Without it that check is skipped. */
  projectsDir?: string;
  /** The research team's folder. Must also be one of `roots`. Without it a research team cannot start. */
  researchDir?: string;
  /** GitHub client for the research workers' tools. */
  github?: Github;
  sessionBudgetUsd?: number;
  totalBudgetUsd?: number;
  inspect?: (pid: number) => Promise<ProcessInfo | null>;
  killTree?: (pid: number) => Promise<void>;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
};

type Managed = {
  id: string | null;
  /** Set when this run continues a stored conversation: it must report this same id. */
  expectedId: string | null;
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
  name: string;
  project: string;
  cwd: string;
  task: string;
  role: "worker" | "master";
  /** Set for a research team's master and the workers it starts. */
  team: "research" | null;
  /** The master that started this worker. Set by the server, never by a model. */
  owner: Managed | null;
  /** Final text of the last finished task, at most MAX_RESULT_CHARS. In memory only. */
  result: string | null;
  lastText: string;
  createdAt: number;
  updatedAt: number;
  procName: string | null;
  pidStartedAt: number | null;
  /** Cost of the earlier runs of this conversation. */
  baseCost: number;
  /** Cost of this run, as the SDK reports it. */
  runCost: number;
  /** A task is in progress. */
  busy: boolean;
  /** Paused at the subscription's usage limit. */
  waiting: boolean;
  endNote: string | null;
  forgetTimer: NodeJS.Timeout | null;
  done: Promise<void>;
  resolveId: (id: string) => void;
  rejectId: (error: Error) => void;
  idReady: Promise<string>;
};

type NewManaged = Pick<Managed, "cwd" | "project" | "name" | "task" | "expectedId" | "baseCost"> & { createdAt?: number; role?: Managed["role"]; owner?: Managed | null; team?: Managed["team"] };

export function createSupervisor(opts: SupervisorOptions) {
  const { registry, roots, env } = opts;
  const maxManaged = opts.maxManaged ?? 8;
  const maxMasters = opts.maxMasters ?? 1;
  const maxWorkersPerMaster = opts.maxWorkersPerMaster ?? 5;
  const stopGraceMs = opts.stopGraceMs ?? 10_000;
  const startTimeoutMs = opts.startTimeoutMs ?? 30_000;
  const forgetAfterMs = opts.forgetAfterMs ?? 24 * 3_600_000;
  const killTree = opts.killTree ?? defaultKillTree;
  const now = opts.now ?? Date.now;
  const inspect = opts.inspect ?? inspectProcess;
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const budget = createBudget({
    runUsd: MAX_BUDGET_USD,
    sessionUsd: opts.sessionBudgetUsd ?? DEFAULT_SESSION_BUDGET_USD,
    totalUsd: opts.totalBudgetUsd ?? DEFAULT_TOTAL_BUDGET_USD,
  });

  const all = new Set<Managed>(); // every worker that has not been forgotten
  const byId = new Map<string, Managed>();
  const detached = new Map<string, StoredWorker>(); // found in the file after a restart, not running
  const resuming = new Set<string>();
  const waiters = new Set<() => void>(); // wait_for_workers calls to wake when a worker settles
  const timers = new Set<NodeJS.Timeout>();
  let saving: Promise<void> = Promise.resolve();

  const live = () => [...all].filter((m) => m.state !== "ended");
  const sessionCost = (m: { baseCost: number; runCost: number }) => m.baseCost + m.runCost;

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
    if (m.pid !== null) {
      // Recorded so that a leftover process can be recognised after a crash.
      void inspect(m.pid).then((info) => {
        if (!info) return;
        m.procName = info.name;
        m.pidStartedAt = info.startedAtMs;
        if (m.id) persist();
      });
    }
    child.stderr?.resume(); // nobody reads it, but an unread pipe can block the child
    child.once("exit", () => {
      m.exited = true;
    });
    child.on("error", (error) => log({ event: "managed-process-error", message: error.message }));
    return child;
  }

  function toStored(m: Managed & { id: string }): StoredWorker {
    const running = m.state !== "ended" && m.procName !== null && m.pidStartedAt !== null;
    return {
      id: m.id,
      name: m.name,
      project: m.project,
      task: m.task,
      cwd: m.cwd,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      pid: running ? m.pid : null,
      processName: running ? m.procName : null,
      pidStartedAt: running ? m.pidStartedAt : null,
      costUsdTotal: sessionCost(m),
    };
  }

  /** Writes the worker file in the background. Writes are queued so they never overlap. */
  function persist() {
    const dir = opts.dataDir;
    if (!dir) return;
    const workers = [...all].filter((m): m is Managed & { id: string } => m.id !== null).map(toStored);
    workers.push(...detached.values());
    saving = saving.then(() => saveStore(dir, workers)).catch(() => log({ event: "store-error" }));
  }

  function forget(m: Managed) {
    if (m.forgetTimer) {
      clearTimeout(m.forgetTimer);
      timers.delete(m.forgetTimer);
    }
    if (m.id) {
      registry.remove(m.id);
      byId.delete(m.id);
    }
    all.delete(m);
    persist();
  }

  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  const ownedBy = (owner: Managed) => [...all].filter((w) => w.owner === owner);
  /** A master that stops or dies leaves no running worker behind. */
  function stopWorkersOf(owner: Managed) {
    for (const w of ownedBy(owner)) if (w.state !== "ended" && !w.stopRequested) void terminate(w);
  }

  function finalize(m: Managed, status: "stopped" | "error") {
    if (m.state === "ended") return;
    m.state = "ended";
    m.updatedAt = now();
    if (m.role === "master") stopWorkersOf(m);
    notify();
    if (m.id) {
      registry.setTerminal(m.id, status);
      registry.setNote(m.id, m.endNote ?? (status === "error" ? "The session ended with an error." : null));
      const timer = setTimeout(() => forget(m), forgetAfterMs);
      timer.unref();
      timers.add(timer);
      m.forgetTimer = timer;
      persist();
    } else {
      all.delete(m);
      m.rejectId(new Error("ended before the session started"));
    }
  }

  function pause(m: Managed, resetsAt: number | undefined) {
    if (m.id === null) return;
    m.busy = false;
    m.waiting = true;
    notify();
    registry.setWaiting(m.id, true);
    const reset = resetsAt ? ` Resets around ${resetTime(resetsAt)}.` : "";
    registry.setNote(m.id, `Usage limit reached.${reset} Give it a task to try again.`);
    log({ event: "managed-rate-limit", id: m.id });
  }

  function capReached(m: Managed, cap: Cap) {
    log({ event: "managed-cap", id: m.id, cap });
    m.endNote = CAP_NOTE[cap];
    void terminate(m);
  }

  /** A resumed run took over its conversation: the earlier record of it is replaced. */
  function adopt(m: Managed, id: string) {
    const old = byId.get(id);
    if (old && old !== m) {
      if (old.forgetTimer) {
        clearTimeout(old.forgetTimer);
        timers.delete(old.forgetTimer);
      }
      all.delete(old);
    }
    detached.delete(id);
    registry.reopen(id);
    registry.setNote(id, null);
    registry.apply(id, [{ kind: "prompt", text: m.task }, { kind: "event" }], null);
  }

  function handle(m: Managed, message: SDKMessage) {
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
        if (m.expectedId !== null && id !== m.expectedId) {
          log({ event: "managed-refused", reason: "id_mismatch" });
          m.rejectId(new Error("resumed session reported another id"));
          void terminate(m);
          return;
        }
        m.id = id;
        m.state = "running";
        if (m.expectedId !== null) adopt(m, id);
        else {
          registry.upsert(id, {
            kind: "session",
            origin: "managed",
            role: m.role,
            ...(m.team ? { team: m.team } : {}),
            parentId: m.owner?.id ?? null,
            project: m.project,
            name: m.name,
            currentTask: m.task,
          });
        }
        byId.set(id, m);
        log({ event: "managed-session", id, tools: Array.isArray(message.tools) ? message.tools : [] });
        persist();
        m.resolveId(id);
      }
      return;
    }
    if (m.id === null) return;
    if (message.type === "rate_limit_event") {
      if (message.rate_limit_info.status === "rejected") pause(m, message.rate_limit_info.resetsAt);
    } else if (message.type === "assistant" || message.type === "user") {
      if (message.type === "assistant" && message.error === "rate_limit") pause(m, undefined);
      if (message.type === "assistant" && message.parent_tool_use_id === null) m.lastText = textOf(message);
      const parsed = parseValue(message);
      if (parsed.ok) registry.apply(m.id, parsed.facts, null);
    } else if (message.type === "result") {
      m.busy = false;
      m.result = (("result" in message && typeof message.result === "string" && message.result) || m.lastText).slice(0, MAX_RESULT_CHARS);
      notify();
      registry.apply(m.id, [{ kind: "event" }], null);
      const run = message.total_cost_usd;
      if (Number.isFinite(run) && run > m.runCost) {
        budget.add(run - m.runCost);
        m.runCost = run;
      }
      log({ event: "managed-turn-end", id: m.id, subtype: message.subtype });
      const cap = message.subtype === "error_max_budget_usd" ? "run" : budget.reached(m.runCost, sessionCost(m));
      if (cap) return capReached(m, cap);
      m.updatedAt = now();
      persist();
    }
  }

  async function consume(m: Managed) {
    try {
      for await (const message of m.query as Query) {
        if (m.state === "ended") break;
        handle(m, message);
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

  function newManaged(init: NewManaged): Managed {
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
      updatedAt: now(),
      procName: null,
      pidStartedAt: null,
      runCost: 0,
      busy: true,
      waiting: false,
      endNote: null,
      forgetTimer: null,
      role: "worker",
      team: null,
      owner: null,
      result: null,
      lastText: "",
      ...init,
      createdAt: init.createdAt ?? now(),
    };
    all.add(m);
    return m;
  }

  /** Starts the session and waits for its id. Returns null, leaving nothing behind, when it does not start. */
  async function launch(m: Managed, prompt: string): Promise<string | null> {
    m.input.push(userMessage(prompt));
    // Only workers of a research team get the GitHub tools; the Lead only delegates, so it does not.
    const github = m.role === "worker" && m.team === "research" ? opts.github : undefined;
    const extra = m.role === "master" ? OFFICE_TOOL_NAMES : github ? GITHUB_TOOL_NAMES : [];
    try {
      m.query = opts.query({
        prompt: m.input.iterable,
        options: {
          ...lockdownOptions(extra),
          ...(m.role === "master"
            ? {
                // In-process tools only; strictMcpConfig (from the lockdown) keeps every other MCP server out.
                mcpServers: { [OFFICE_SERVER]: createOfficeServer(officeApi(m)) },
                systemPrompt: {
                  type: "preset" as const,
                  preset: "claude_code" as const,
                  append: m.team === "research" ? `${MASTER_SYSTEM_PROMPT}

${RESEARCH_LEAD_PROMPT}` : MASTER_SYSTEM_PROMPT,
                },
              }
            : {}),
          ...(github
            ? {
                mcpServers: { [GITHUB_SERVER]: createGithubServer(github) },
                systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: RESEARCHER_PROMPT },
                maxTurns: MAX_TURNS,
              }
            : {}),
          ...(m.expectedId ? { resume: m.expectedId } : {}),
          // Keeps every file tool inside this folder; permission rules alone would allow any path.
          hooks: folderGuardHooks(m.cwd, (tool, reason) => log({ event: "managed-tool-denied", tool, reason }), extra),
          cwd: m.cwd,
          env: buildChildEnv(env),
          abortController: m.abort,
          spawnClaudeCodeProcess: (o) => spawnTracked(m, o),
        },
      });
    } catch (error) {
      all.delete(m);
      log({ event: "managed-error", message: error instanceof Error ? error.message : String(error) });
      return null;
    }
    m.done = consume(m);
    try {
      const id = await withTimeout(m.idReady, startTimeoutMs);
      log({ event: m.expectedId ? "managed-resume" : "managed-start", id });
      return id;
    } catch {
      await terminate(m);
      finalize(m, "error");
      all.delete(m);
      return null;
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

  /** Starts a session after all checks. A session with an owner must stay inside the owner's folder. */
  async function begin(req: StartMasterRequest, role: Managed["role"], owner: Managed | null): Promise<StartResult> {
    const refuse = (status: 400 | 403 | 409 | 429, code: Extract<StartResult, { ok: false }>["code"]): StartResult => {
      log({ event: "managed-refused", reason: code });
      return { ok: false, status, code };
    };
    if (budget.refuses(0)) return refuse(429, "budget");
    const team = owner?.team ?? req.team ?? null;
    // A research team lives in the research folder: that is its default and its limit.
    let teamRoot: string | null = null;
    if (team && !owner) {
      const research = opts.researchDir ? await resolveAllowedFolder(opts.researchDir, roots) : null;
      if (!research?.ok) return refuse(400, "no_research_folder");
      teamRoot = research.path;
    }
    const cwd = req.cwd ?? teamRoot;
    if (cwd === null) return refuse(400, "invalid_folder");
    const requested = owner && !isAbsolute(cwd) ? resolve(owner.cwd, cwd) : cwd;
    const folder = await resolveAllowedFolder(requested, roots);
    if (!folder.ok) return folder.reason === "outside_roots" ? refuse(403, "folder_not_allowed") : refuse(400, "invalid_folder");
    if (teamRoot !== null && !isInside(teamRoot, folder.path)) return refuse(403, "folder_not_allowed");
    // No await between these checks and adding the session, so two starts cannot both pass.
    if (owner && !isInside(owner.cwd, folder.path)) return refuse(403, "folder_not_allowed");
    if (owner && owner.state !== "running") return refuse(409, "master_stopped");
    if (role === "master" && live().filter((x) => x.role === "master").length >= maxMasters) return refuse(409, "master_running");
    if (owner && ownedBy(owner).filter((w) => w.state !== "ended").length >= maxWorkersPerMaster) return refuse(429, "worker_limit");
    if (live().length >= maxManaged) return refuse(429, "too_many");
    const m = newManaged({
      cwd: folder.path,
      project: clean(folder.path.split(/[\\/]/).filter(Boolean).pop() ?? "") || "unknown",
      name: req.name ? clean(req.name) : role === "master" ? "Master" : "Worker",
      task: clean(req.prompt),
      expectedId: null,
      baseCost: 0,
      role,
      owner,
      team,
    });
    const id = await launch(m, req.prompt);
    return id ? { ok: true, id } : { ok: false, status: 502, code: "start_failed" };
  }

  function assignTask(id: string, prompt: string): CommandResult {
    const m = byId.get(id);
    if (!m) return detached.has(id) ? { ok: false, status: 409, code: "detached" } : { ok: false, status: 404, code: "not_found" };
    if (m.state === "ended" || m.state === "stopping") return { ok: false, status: 409, code: "stopped" };
    if (m.state === "starting" || (m.busy && !m.waiting)) return { ok: false, status: 409, code: "busy" };
    if (budget.refuses(sessionCost(m))) {
      log({ event: "managed-refused", reason: "budget", id });
      return { ok: false, status: 429, code: "budget" };
    }
    m.waiting = false;
    m.busy = true;
    m.result = null;
    m.task = clean(prompt);
    m.updatedAt = now();
    registry.setWaiting(id, false);
    registry.setNote(id, null);
    registry.apply(id, [{ kind: "prompt", text: m.task }, { kind: "event" }], null);
    m.input.push(userMessage(prompt));
    log({ event: "managed-assign", id });
    persist();
    return { ok: true };
  }

  const REFUSALS: Record<string, string> = {
    busy: "That worker is still busy. Wait for it to finish.",
    stopped: "That worker has stopped.",
    detached: "That worker is detached and cannot take tasks.",
    budget: "The usage cap was reached.",
    too_many: "Too many sessions are running. Stop one first.",
    worker_limit: `You already have ${maxWorkersPerMaster} running workers. Stop one first.`,
    folder_not_allowed: "That folder is not allowed. It must be inside your own folder.",
    invalid_folder: "That folder does not exist.",
    master_stopped: "You have been stopped.",
  };
  const failed = (code: string): Reply => ({ ok: false, error: REFUSALS[code] ?? "The worker could not be started." });
  const NOT_YOURS: Reply = { ok: false, error: "Not yours: none of your workers has that id." };

  const stateOf = (w: Managed) =>
    w.state === "ended" ? (w.failed || w.refused ? "error" : "stopped") : w.state === "stopping" ? "stopped" : w.waiting ? "waiting" : w.busy ? "working" : "idle";
  const isSettled = (w: Managed) => w.state === "ended" || w.state === "stopping" || !w.busy || w.waiting;

  /** The tools of one master. Every lookup goes through ownedBy(owner), so only its own workers can be reached. */
  function officeApi(owner: Managed): OfficeApi {
    const mine = (id: string) => ownedBy(owner).find((w) => w.id === id);
    const row = (w: Managed) => ({ id: w.id, name: w.name, state: stateOf(w), ...(isSettled(w) && w.result !== null ? { result: w.result } : {}) });
    return {
      async spawn({ name, folder, task }) {
        const res = await begin({ cwd: folder, prompt: task, name }, "worker", owner);
        return res.ok ? { ok: true, data: { id: res.id } } : failed(res.code);
      },
      assign(id, task) {
        if (!mine(id)) return NOT_YOURS;
        const res = assignTask(id, task);
        return res.ok ? { ok: true, data: { id } } : failed(res.code);
      },
      async wait(ids, seconds) {
        const picked = ids ? ids.map(mine) : ownedBy(owner);
        const workers = picked.filter((w): w is Managed => w !== undefined);
        if (workers.length !== picked.length) return NOT_YOURS;
        const done = () => owner.state === "ended" || workers.every(isSettled);
        if (!done()) {
          const ms = Math.min(Math.max(seconds, 1), MAX_WAIT_SECONDS) * 1000;
          await new Promise<void>((resolveWait) => {
            const finish = () => {
              clearTimeout(timer);
              waiters.delete(check);
              resolveWait();
            };
            const check = () => done() && finish();
            const timer = setTimeout(finish, ms);
            timer.unref();
            waiters.add(check);
          });
        }
        return { ok: true, data: { still_working: !workers.every(isSettled), workers: workers.map(row) } };
      },
      async stop(id) {
        const w = mine(id);
        if (!w) return NOT_YOURS;
        await terminate(w);
        return { ok: true, data: { id, state: stateOf(w) } };
      },
      list() {
        return { ok: true, data: { workers: ownedBy(owner).map((w) => ({ ...row(w), task: w.task })) } };
      },
    };
  }

  return {
    start: (req: StartRequest) => begin(req, "worker", null),

    /** Starts a master: a session with the office tools. Only the page does this, never a model. */
    startMaster: (req: StartMasterRequest) => begin(req, "master", null),

    /** Gives an idle worker a new task. Answers at once; the work continues in the background. */
    assign: assignTask,

    /** Continues a stopped or detached conversation under the same session id. Nothing resumes by itself. */
    async resume(id: string, prompt = DEFAULT_RESUME_PROMPT): Promise<CommandResult> {
      const refuse = (status: 400 | 403 | 404 | 409 | 429 | 502, code: Extract<CommandResult, { ok: false }>["code"]): CommandResult => {
        log({ event: "managed-refused", reason: code, id });
        return { ok: false, status, code };
      };
      const old = byId.get(id);
      const from = old ?? detached.get(id);
      if (!from) return refuse(404, "not_found");
      if ((old && old.state !== "ended") || resuming.has(id)) return refuse(409, "not_resumable");
      const baseCost = old ? sessionCost(old) : (from as StoredWorker).costUsdTotal;
      if (budget.refuses(baseCost)) return refuse(429, "budget");

      resuming.add(id);
      try {
        const folder = await resolveAllowedFolder(from.cwd, roots);
        if (!folder.ok) return folder.reason === "outside_roots" ? refuse(403, "folder_not_allowed") : refuse(400, "invalid_folder");
        if (opts.projectsDir && (await transcriptActive(opts.projectsDir, id, now()))) return refuse(409, "transcript_active");
        if (live().length >= maxManaged) return refuse(429, "too_many");
        const m = newManaged({ cwd: folder.path, project: from.project, name: from.name, task: clean(prompt), expectedId: id, baseCost, createdAt: from.createdAt });
        return (await launch(m, prompt)) ? { ok: true } : refuse(502, "start_failed");
      } finally {
        resuming.delete(id);
      }
    },

    /**
     * Reads the worker file after a restart: stops leftover processes that match, and lists the
     * workers as detached. It never starts a session; the user presses Resume.
     */
    async recover(): Promise<void> {
      const dir = opts.dataDir;
      if (!dir) return;
      await cleanTmp(dir);
      const everything = await loadStore(dir);
      // Old entries are still checked for a leftover process; only then are they forgotten.
      const killed = await killLeftovers(everything, { inspect, kill: killTree });
      const stored = freshOnly(everything, now());
      for (const w of stored) {
        registry.upsert(w.id, { kind: "session", origin: "managed", role: "worker", parentId: null, project: w.project, name: w.name, currentTask: w.task });
        registry.setTerminal(w.id, "detached");
        registry.setNote(w.id, "Detached after a restart. Press Resume to continue the conversation.");
        detached.set(w.id, { ...w, pid: null, processName: null, pidStartedAt: null });
      }
      log({ event: "managed-recovered", workers: stored.length, killed });
      persist();
    },

    /** Ends one worker, by force if it had to. On a worker that has already ended or is detached it forgets the worker instead. */
    async stop(id: string): Promise<"ok" | "not_found"> {
      if (detached.delete(id)) {
        registry.remove(id);
        persist();
        return "ok";
      }
      const m = byId.get(id);
      if (!m) return "not_found";
      if (m.state === "ended") forget(m);
      else await terminate(m);
      return "ok";
    },

    async stopAll(): Promise<void> {
      await Promise.all(live().map(terminate));
    },

    /** True for every worker this app started (also after it ended or when detached), so the log watcher skips it. */
    claims: (id: string) => byId.has(id) || detached.has(id),
    /** True while a worker is waiting for its session id, which is when a new log file could be its own. */
    starting: () => [...all].some((m) => m.state === "starting"),
    liveCount: () => live().length,
    /** Resolves when the file writes queued so far are done. */
    settled: () => saving,

    async close() {
      await Promise.all(live().map(terminate));
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await saving;
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;

const userMessage = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

/** The SDK gives the reset time in seconds since 1970; milliseconds are accepted too. */
function resetTime(value: number): string {
  const ms = value < 1e12 ? value * 1000 : value;
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "an unknown time";
}

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

/** The text blocks of an assistant message, joined. */
function textOf(message: Extract<SDKMessage, { type: "assistant" }>): string {
  const content: unknown = message.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("");
}
