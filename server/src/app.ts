import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { z } from "zod";
import type { ServerEvent } from "../../shared/events.ts";
import { HttpError, readJson } from "./body.ts";
import { listAgents, listMcpServers, listSkills } from "./claudeSetup.ts";
import { changedSkillDir, readCases, readEval, readEvalRound, reviseGoal, runEval, saveEval, scratchDir, skillTexts, supervisorSession } from "./skillEval.ts";
import { buildBriefPrompt, checkBrief, evalsJson, readBriefs, saveBrief, type Brief } from "./briefs.ts";
import { addAgent, addedAgents, agentDirsFor, removeAgent } from "./agentsManage.ts";
import type { ClaudeRunner } from "./claudeCli.ts";
import { addedServers, addServer, buildArgs, previewLine, removeServer, type Failure as McpFailure, type McpInput } from "./mcpManage.ts";
import { addedSkills, addSkill, dirsFor, removeSkill, SKILL_NAME, type Failure } from "./skillsManage.ts";
import { buildWorkshopGoal, MAX_ROUNDS, type Workshop } from "./workshop.ts";
import { buildEvaluationPrompt, readEvaluations } from "./evaluations.ts";
import { ConfigBody, createDecisionStore, type DecisionStore, DecisionBody, readConfig, readFinding, readFindings, resolveResearch, SLUG, withDecisions, writeConfig } from "./findings.ts";
import { PlanBody } from "./plan.ts";
import { listOutcomes } from "./planLog.ts";
import { AutoApproveBody, type AutoApproveStore } from "./autoApprove.ts";
import { ModeBody, type Scheduler } from "./schedule.ts";
import type { Registry } from "./registry.ts";
import { sweepPromptFor } from "./sweep.ts";
import type { Supervisor } from "./supervisor.ts";
import { createVault } from "./vault.ts";

export type RunningServer = {
  server: http.Server;
  port: number;
  /** One-time secret that the startup URL carries. Print it once, never log it. */
  token: string;
  close(): Promise<void>;
};

type Options = {
  port?: number;
  /** Extra port the browser may use, such as the Vite dev server. */
  publicPort?: number;
  staticDir: string;
  heartbeatMs?: number;
  /** When given, /events starts with a snapshot of its agents and then streams changes. */
  registry?: Registry;
  /** When given, the browser can start and stop workers. */
  supervisor?: Supervisor;
  /** Obsidian vault folder to read titles and links from. Never taken from a request. */
  vaultDir?: string;
  /** The research folder: findings, focus and needs notes live here. Without it the research routes answer 400. */
  researchDir?: string;
  /** The vault's plans-log folder (outcome notes). Without it the outcomes route answers an empty list. */
  plansLogDir?: string;
  /** Tells a sweep what we use and have been doing (names and short run lines). Without it the sweep prompt has no such section. */
  digest?: () => Promise<string>;
  /** The app's data folder, for the decisions file. */
  dataDir?: string;
  /** The scheduled-sweep setting and its timer. Without it the schedule routes answer 404. */
  scheduler?: Scheduler;
  /** The auto-approve rule for plans. Share it with the supervisor. Without it the auto-approve routes answer 404. */
  autoApprove?: AutoApproveStore;
  /** Share the decision store with the supervisor (one cache). Without it the app makes its own. */
  decisions?: DecisionStore;
  /** Where the sidebar reads the owner's skills and user-level MCP servers from. Without it the lists are empty. */
  setup?: { skillsDir: string; mcpFile: string; /** The folder of Claude Code agent files (name.md). */ agentsDir?: string; /** Where the trash and the list of skills added here live. Without it skills cannot be added or removed. */ dataDir?: string; /** Runs the owner's `claude` program for MCP add and remove. Without it MCP servers are listed but not changed. */ runClaude?: ClaudeRunner };
  /** The Workshop (builds in a copy of the target). Without it the Workshop routes answer 404. */
  workshop?: Workshop;
  /** The target folder's display name, for the master's goal. */
  workshopTargetName?: string;
  /**
   * Dev only. At least 32 characters: the token becomes HMAC(secret, "token") and sessions become signed
   * cookies, so the same link and login survive a restart. Omit it for the strict one-time token.
   */
  sessionSecret?: string;
  log?: (line: Record<string, unknown>) => void;
};

const SESSION_COOKIE = "office_session";
const AGENT_EVENTS = /^\/api\/agents\/([A-Za-z0-9_-]{1,100})\/events$/;
const AGENT_RESULT = /^\/api\/agents\/([A-Za-z0-9_-]{1,100})\/result$/;
const FINDING_DECISION = /^\/api\/research\/findings\/([^/]{1,200})\/decision$/;
const SKILL_STATUS: Record<Failure, number> = { invalid_name: 400, invalid_skill: 400, too_big: 413, exists: 409, not_found: 404, not_added: 409, source_missing: 400, risky_header: 400, failed: 500 };
const RemoveSkillBody = z.object({ name: z.string().regex(SKILL_NAME), confirm: z.literal(true) }).strict();
const AddSkillBody = z
  .object({ name: z.string().regex(SKILL_NAME), content: z.string().max(200_000).optional(), source: z.string().min(1).max(1000).optional(), confirm: z.literal(true) })
  .strict()
  .refine((b) => (b.content === undefined) !== (b.source === undefined));
const McpBody = z
  .object({
    name: z.string().max(80),
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().max(400).optional(),
    args: z.array(z.string().max(600)).max(30).optional(),
    url: z.string().max(800).optional(),
    env: z.record(z.string().max(80), z.string().max(800)).optional(),
    headers: z.array(z.string().max(800)).max(10).optional(),
  })
  .strict();
const AddMcpBody = McpBody.extend({ confirm: z.literal(true) }).strict();
const RemoveMcpBody = z.object({ name: z.string().max(80), confirm: z.literal(true) }).strict();
const MCP_STATUS: Record<McpFailure, number> = { invalid_input: 400, exists: 409, not_added: 409, failed: 500 };
/** The answer to an MCP add or remove: no CLI output is ever passed on, because it can echo secrets. */
function mcpAnswer(res: http.ServerResponse, result: { ok: true } | { ok: false; code: McpFailure }, okStatus: number) {
  if (result.ok) return json(res, okStatus, {});
  return json(res, MCP_STATUS[result.code], result.code === "exists" || result.code === "not_added" ? { reason: result.code } : { error: result.code });
}
const EvalBody = z.object({ confirm: z.literal(true) }).strict();
const BuildBody = z.object({ findingId: z.string().regex(SLUG) }).strict();
const FINDING_BRIEF = /^\/api\/research\/findings\/([^/]{1,200})\/brief(\/save)?$/;
const BriefEdit = z
  .object({
    goal: z.string().max(400),
    files: z.string().max(400),
    criteria: z.string().max(500),
    cases: z.array(z.object({ prompt: z.string().max(500), assertions: z.array(z.string().max(300)).min(1).max(5) }).strict()).min(2).max(3),
  })
  .strict();
const FINDING_EVALUATE = /^\/api\/research\/findings\/([^/]{1,200})\/evaluate$/;
const AGENT_COMMAND = /^\/api\/agents\/([A-Za-z0-9_-]{1,100})\/(tasks|stop|resume|plan)$/;

const StartBody = z
  .object({
    role: z.enum(["worker", "master"]),
    cwd: z.string().min(1).max(1000).optional(),
    team: z.literal("research").optional(),
    prompt: z.string().min(1).max(10_000),
    name: z.string().min(1).max(100).optional(),
  })
  .strict()
  // A team belongs to a master. Only a research team may leave the folder out (it defaults to the research folder).
  .refine((b) => (b.team === undefined || b.role === "master") && (b.cwd !== undefined || b.team !== undefined));
const TaskBody = z.object({ prompt: z.string().min(1).max(10_000) }).strict();
const ResumeBody = z.object({ prompt: z.string().min(1).max(10_000).optional() }).strict();
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const MIN_SECRET_LENGTH = 32;
const REFUSED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Link not valid</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}</style></head><body><main><h1>This link does not work</h1><p>It was already used, or the server was restarted since it was printed.</p><p>Copy the newest line that starts with <strong>Open this</strong> from the terminal and open it once, in one tab.</p></main></body></html>`;
const REFUSED_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

export async function startServer(opts: Options): Promise<RunningServer> {
  const { staticDir, heartbeatMs = 5000 } = opts;
  const root = resolve(staticDir);
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const secret = opts.sessionSecret;
  if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`sessionSecret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const token = secret ? hmac(secret, "token:v1") : randomBytes(32).toString("hex");
  let tokenUsed = false;
  const sessions = new Set<string>();
  const newSession = () => {
    const id = randomBytes(32).toString("hex");
    if (!secret) {
      sessions.add(id);
      return id;
    }
    return `${id}.${hmac(secret, `session:${id}`)}`;
  };
  const validSession = (value: string) => {
    if (!secret) return sessions.has(value);
    const [id, sig, ...extra] = value.split(".");
    return id !== undefined && sig !== undefined && extra.length === 0 && sameSecret(sig, hmac(secret, `session:${id}`));
  };
  const streams = new Set<http.ServerResponse>();
  const allowedHosts = new Set<string>();
  const vault = createVault(opts.vaultDir);
  // Skill evals running now, by build id: one at a time, and the page watches the progress.
  const evalRuns = new Map<string, { done: number; total: number; failed?: true }>();
  const decisions = opts.researchDir && opts.dataDir ? (opts.decisions ?? createDecisionStore(opts.dataDir)) : undefined;

  const deny = (res: http.ServerResponse, status: number, reason: string, req: http.IncomingMessage) => {
    // Log the path only. The query string can hold the token.
    log({ event: "denied", status, reason, method: req.method, path: pathOf(req) });
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(status === 403 ? "Forbidden" : "Error");
  };

  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const host = req.headers.host?.toLowerCase();
    if (!host || !allowedHosts.has(host)) return deny(res, 403, "host", req);

    // The request target is untrusted. `new URL` throws on inputs like "//" or "/\", and a
    // throw in this handler would take the whole server down. It also reads "/\x" and "//x"
    // as a host, so anything that parses to a different host than the placeholder is refused.
    const target = req.url ?? "";
    let url: URL;
    try {
      url = new URL(target, "http://placeholder");
    } catch {
      return deny(res, 400, "bad-url", req);
    }
    if (!target.startsWith("/") || url.host !== "placeholder") return deny(res, 400, "bad-url", req);

    const method = req.method ?? "GET";
    const safeMethod = method === "GET" || method === "HEAD";
    if (!safeMethod) {
      const origin = req.headers.origin;
      if (!origin?.startsWith("http://") || !allowedHosts.has(origin.slice("http://".length).toLowerCase())) {
        return deny(res, 403, "origin", req);
      }
    }

    if (url.pathname === "/api/session") {
      if (method !== "GET") return deny(res, 405, "method", req);
      // Browsers prefetch or prerender a pasted URL. Only a real navigation may use the token up.
      if (isPreload(req)) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        return res.end();
      }
      const given = url.searchParams.get("t") ?? "";
      if ((tokenUsed && !secret) || !sameSecret(given, token)) {
        log({ event: "denied", status: 403, reason: "token", method, path: pathOf(req) });
        res.writeHead(403, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": REFUSED_CSP,
        });
        return res.end(REFUSED_PAGE);
      }
      tokenUsed = true;
      const session = newSession();
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    if (url.pathname === "/events" || url.pathname.startsWith("/api/")) {
      if (!validSession(cookieValue(req.headers.cookie, SESSION_COOKIE))) {
        return deny(res, 403, "no-session", req);
      }
      if (url.pathname === "/events" && method === "GET") return openStream(res);
      if (url.pathname === "/api/vault" && method === "GET") {
        return run(req, res, async () => json(res, 200, await vault.get(url.searchParams.get("refresh") === "1")));
      }
      if (url.pathname === "/api/outcomes" && method === "GET") return run(req, res, async () => json(res, 200, await listOutcomes(opts.plansLogDir)));
      const history = AGENT_EVENTS.exec(url.pathname);
      if (history?.[1] && method === "GET") {
        const events = opts.registry?.events(history[1]);
        return events ? json(res, 200, { events }) : json(res, 404, { error: "not_found" });
      }
      if (url.pathname.startsWith("/api/research/")) {
        const handled = researchRoute(req, res, url.pathname, method);
        if (handled) return;
      }
      if (url.pathname === "/api/setup" && method === "GET") {
        return run(req, res, async () => {
          const dirs = opts.setup?.dataDir && opts.setup.skillsDir ? dirsFor(opts.setup.skillsDir, opts.setup.dataDir) : undefined;
          const added = dirs ? await addedSkills(dirs) : new Set<string>();
          const skills = (await listSkills(opts.setup?.skillsDir)).map((s) => ({ ...s, added: added.has(s.name) }));
          const mcpAdded = opts.setup?.dataDir ? await addedServers(join(opts.setup.dataDir, "mcp-added.json")) : new Set<string>();
          const mcp = (await listMcpServers(opts.setup?.mcpFile)).map((s) => ({ ...s, added: mcpAdded.has(s.name) }));
          const agentDirs = opts.setup?.dataDir && opts.setup.agentsDir ? agentDirsFor(opts.setup.agentsDir, opts.setup.dataDir) : undefined;
          const agentsAdded = agentDirs ? await addedAgents(agentDirs) : new Set<string>();
          const agents = (await listAgents(opts.setup?.agentsDir)).map((a) => ({ ...a, added: agentsAdded.has(a.name) }));
          return json(res, 200, { skills, mcp, agents, canManage: Boolean(dirs), canManageAgents: Boolean(agentDirs), canManageMcp: Boolean(opts.setup?.runClaude && opts.setup.dataDir) });
        });
      }
      if ((url.pathname === "/api/setup/mcp/preview" || url.pathname === "/api/setup/mcp" || url.pathname === "/api/setup/mcp/remove") && method === "POST") {
        const setup = opts.setup;
        const runner = setup?.runClaude;
        if (!setup?.dataDir || !runner) return json(res, 404, { error: "not_found" });
        const deps = { run: runner, addedFile: join(setup.dataDir, "mcp-added.json"), existing: async () => (await listMcpServers(setup.mcpFile)).map((s) => s.name) };
        return run(req, res, async () => {
          const body = await readJson(req);
          if (url.pathname.endsWith("/remove")) {
            const parsed = RemoveMcpBody.safeParse(body);
            if (!parsed.success) return json(res, 400, { error: "invalid_request" });
            return mcpAnswer(res, await removeServer(deps, parsed.data.name), 200);
          }
          const preview = url.pathname.endsWith("/preview");
          const parsed = (preview ? McpBody : AddMcpBody).safeParse(body);
          if (!parsed.success) return json(res, 400, { error: "invalid_request" });
          const d = parsed.data;
          const input: McpInput = { name: d.name, transport: d.transport, ...(d.command !== undefined ? { command: d.command } : {}), ...(d.args !== undefined ? { args: d.args } : {}), ...(d.url !== undefined ? { url: d.url } : {}), ...(d.env !== undefined ? { env: d.env } : {}), ...(d.headers !== undefined ? { headers: d.headers } : {}) };
          if (preview) {
            const args = buildArgs(input);
            return args ? json(res, 200, { command: previewLine(args) }) : json(res, 400, { error: "invalid_input" });
          }
          return mcpAnswer(res, await addServer(deps, input), 201);
        });
      }
      if ((url.pathname === "/api/setup/agents" || url.pathname === "/api/setup/agents/remove") && method === "POST") {
        const agentDirs = opts.setup?.dataDir && opts.setup.agentsDir ? agentDirsFor(opts.setup.agentsDir, opts.setup.dataDir) : undefined;
        if (!agentDirs) return json(res, 404, { error: "not_found" });
        return run(req, res, async () => {
          const remove = url.pathname.endsWith("/remove");
          const parsed = (remove ? RemoveSkillBody : AddSkillBody).safeParse(await readJson(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_request" });
          const result = remove ? await removeAgent(agentDirs, parsed.data.name) : await addAgent(agentDirs, parsed.data);
          if (result.ok) return json(res, remove ? 200 : 201, {});
          return json(res, SKILL_STATUS[result.code], result.code === "exists" || result.code === "not_added" ? { reason: result.code } : { error: result.code });
        });
      }
      if ((url.pathname === "/api/setup/skills" || url.pathname === "/api/setup/skills/remove") && method === "POST") {
        const dirs = opts.setup?.dataDir && opts.setup.skillsDir ? dirsFor(opts.setup.skillsDir, opts.setup.dataDir) : undefined;
        if (!dirs) return json(res, 404, { error: "not_found" });
        return run(req, res, async () => {
          const remove = url.pathname.endsWith("/remove");
          const parsed = (remove ? RemoveSkillBody : AddSkillBody).safeParse(await readJson(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_request" });
          const result = remove ? await removeSkill(dirs, parsed.data.name) : await addSkill(dirs, parsed.data);
          if (result.ok) return json(res, remove ? 200 : 201, {});
          return json(res, SKILL_STATUS[result.code], result.code === "exists" || result.code === "not_added" ? { reason: result.code } : { error: result.code });
        });
      }
      if (url.pathname === "/api/workshop" || url.pathname.startsWith("/api/workshop/")) {
        if (workshopRoute(req, res, url.pathname, method)) return;
      }
      if (url.pathname === "/api/auto-approve" && (method === "GET" || method === "POST")) {
        const store = opts.autoApprove;
        if (!store) return json(res, 404, { error: "not_found" });
        return run(req, res, async () => {
          if (method === "GET") return json(res, 200, await store.get());
          const parsed = AutoApproveBody.safeParse(await readJson(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_request" });
          json(res, 200, await store.update(parsed.data));
        });
      }
      if (url.pathname === "/api/usage" && method === "GET" && opts.supervisor) return json(res, 200, opts.supervisor.usage());
      const answer = AGENT_RESULT.exec(url.pathname);
      if (answer?.[1] && method === "GET") {
        const agent = opts.registry?.get(answer[1]);
        if (!agent || agent.origin === "observed" || !opts.supervisor) return json(res, 404, { error: "not_found" });
        return json(res, 200, { result: opts.supervisor.resultOf(agent.id) });
      }
      if (method === "POST" && opts.supervisor) {
        if (url.pathname === "/api/agents") return run(req, res, () => startWorker(req, res));
        if (url.pathname === "/api/agents/stop-all") {
          return run(req, res, async () => {
            await opts.supervisor?.stopAll();
            json(res, 202, {});
          });
        }
      }
      const command = AGENT_COMMAND.exec(url.pathname);
      if (command?.[1] && method === "POST") {
        const agent = opts.registry?.get(command[1]);
        if (!agent) return json(res, 404, { error: "not_found" });
        if (command[2] === "plan") {
          if (agent.role !== "master" || !opts.supervisor) return json(res, 404, { error: "not_found" });
          const supervisor = opts.supervisor;
          return run(req, res, async () => {
            const parsed = PlanBody.safeParse(await readJson(req));
            if (!parsed.success) return json(res, 400, { error: "invalid_request" });
            const result = supervisor.decidePlan(agent.id, parsed.data.decision, parsed.data.note);
            if (result.ok) return json(res, 202, {});
            json(res, result.status, result.status === 409 ? { reason: result.code } : { error: result.code });
          });
        }
        // Agents seen only through their logs are view-only.
        if (agent.origin === "observed") return json(res, 409, { reason: "observed" });
        const supervisor = opts.supervisor;
        if (!supervisor) return json(res, 404, { error: "not_found" });
        if (command[2] === "stop") {
          return run(req, res, async () => {
            await supervisor.stop(agent.id);
            json(res, 202, {});
          });
        }
        return run(req, res, async () => {
          const parsed = (command[2] === "tasks" ? TaskBody : ResumeBody).safeParse(await readJson(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_request" });
          const result = command[2] === "tasks" ? supervisor.assign(agent.id, parsed.data.prompt as string) : await supervisor.resume(agent.id, parsed.data.prompt);
          if (result.ok) return json(res, 202, {});
          // A conflict says why in `reason`; every other refusal is an `error` code.
          json(res, result.status, result.status === 409 ? { reason: result.code } : { error: result.code });
        });
      }
      return deny(res, 404, "not-found", req);
    }

    if (!safeMethod) return deny(res, 405, "method", req);
    serveStatic(req, res, url.pathname).catch(() => {
      log({ event: "static-error", path: pathOf(req) });
      if (res.headersSent) res.destroy();
      else deny(res, 500, "internal", req);
    });
  });

  /** Runs an async route and turns any failure into a response, so nothing can crash the server. */
  function run(req: http.IncomingMessage, res: http.ServerResponse, task: () => Promise<void>) {
    task().catch((error: unknown) => {
      if (error instanceof HttpError) {
        log({ event: "route-refused", status: error.status, code: error.code, path: pathOf(req) });
        // After a too-large body the rest of the request is not read, so close the connection.
        return json(res, error.status, { error: error.code }, error.status === 413 ? { Connection: "close" } : {});
      }
      log({ event: "route-error", path: pathOf(req) });
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: "internal" });
    });
  }

  /** The Workshop's routes. Returns false for a path that is not one of them. */
  function workshopRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, method: string): boolean {
    const shop = opts.workshop;
    const patch = /^\/api\/workshop\/([0-9a-f]{12})\/patch$/.exec(pathname);
    const evalPath = /^\/api\/workshop\/([0-9a-f]{12})\/eval$/.exec(pathname);
    const revisePath = /^\/api\/workshop\/([0-9a-f]{12})\/revise$/.exec(pathname);
    const known =
      (pathname === "/api/workshop" && method === "GET") ||
      (pathname === "/api/workshop/build" && method === "POST" && opts.supervisor) ||
      (patch && method === "GET") ||
      (evalPath && (method === "GET" || (method === "POST" && opts.supervisor))) ||
      (revisePath && method === "POST" && opts.supervisor);
    if (!known) return false;
    run(req, res, async () => {
      if (!shop) return json(res, 404, { error: "not_found" });
      if (pathname === "/api/workshop") {
        const builds = await Promise.all((await shop.list()).map(async (b) => {
          const e = await readEval(join(shop.dir, b.id));
          const before = b.round > 1 ? await readEvalRound(join(shop.dir, b.id), b.round - 1) : null;
          return { ...b, ...(before ? { evalBefore: { verdict: before.verdict, withRate: before.withRate, baselineRate: before.baselineRate, delta: before.delta, costUsd: before.costUsd, capped: before.capped, ranAt: before.ranAt } } : {}), ...(e ? { eval: { verdict: e.verdict, withRate: e.withRate, baselineRate: e.baselineRate, delta: e.delta, costUsd: e.costUsd, capped: e.capped, ranAt: e.ranAt } } : {}), ...(evalRuns.has(b.id) ? { evalRun: evalRuns.get(b.id) } : {}) };
        }));
        return json(res, 200, { builds, dir: shop.dir });
      }
      if (revisePath) {
        const sup = opts.supervisor;
        if (!sup || !EvalBody.safeParse(await readJson(req)).success) return json(res, 400, { error: "invalid_request" });
        const id = revisePath[1] as string;
        const build = (await shop.list()).find((b) => b.id === id);
        if (!build) return json(res, 404, { error: "not_found" });
        if (build.status !== "ready") return json(res, 409, { reason: "no_patch" });
        if (build.round >= MAX_ROUNDS) return json(res, 409, { reason: "rounds_used" });
        if (evalRuns.has(id)) return json(res, 409, { reason: "eval_running" });
        const dir = join(shop.dir, id);
        const evaluated = await readEval(dir);
        if (!evaluated) return json(res, 409, { reason: "no_eval" });
        // The master works in the same working copy as before; its plan waits for the owner like any other.
        const started = await sup.startMaster({ cwd: join(await realpath(dir), "b"), prompt: reviseGoal(opts.workshopTargetName ?? "the workspace", evaluated), workshop: id });
        if (!started.ok) return json(res, started.status, started.status === 409 ? { reason: started.code } : { error: started.code });
        await shop.reopen(id);
        return json(res, 202, { id: started.id, round: build.round + 1 });
      }
      if (evalPath && method === "GET") {
        const got = await readEval(join(shop.dir, evalPath[1] as string));
        return got ? json(res, 200, got) : json(res, 404, { error: "not_found" });
      }
      if (evalPath) {
        const sup = opts.supervisor;
        if (!sup || !EvalBody.safeParse(await readJson(req)).success) return json(res, 400, { error: "invalid_request" });
        const id = evalPath[1] as string;
        const build = (await shop.list()).find((b) => b.id === id);
        if (!build) return json(res, 404, { error: "not_found" });
        if (build.status !== "ready") return json(res, 409, { reason: "no_patch" });
        const dir = join(shop.dir, id);
        const cases = await readCases(dir);
        if (!cases) return json(res, 409, { reason: "no_evals" });
        const shown = await shop.patch(id);
        const skillDir = shown ? await changedSkillDir(dir, shown.patch) : null;
        const texts = skillDir === null ? null : await skillTexts(dir, skillDir);
        if (skillDir === null || !texts) return json(res, 409, { reason: "no_skill" });
        if ([...evalRuns.values()].some((r) => !r.failed)) return json(res, 409, { reason: "eval_running" });
        evalRuns.set(id, { done: 0, total: cases.length });
        // The run takes minutes: answer now, and the page watches the build list.
        void (async () => {
          try {
            const scratch = await scratchDir(dir);
            const session = supervisorSession(sup, (agent) => opts.registry?.get(agent)?.usd ?? 0, scratch);
            const result = await runEval({ cases, skill: texts, skillName: skillDir === "" ? build.title : (skillDir.split("/").pop() ?? skillDir), session, progress: (done, total) => evalRuns.set(id, { done, total }) });
            await saveEval(dir, result);
            log({ event: "skill-eval-end", build: id, verdict: result.verdict, costUsd: result.costUsd });
          } catch (error) {
            log({ event: "skill-eval-error", build: id, message: error instanceof Error ? error.message : String(error) });
            // The page shows that the run failed for a minute, instead of the run just vanishing.
            evalRuns.set(id, { done: 0, total: cases.length, failed: true });
            setTimeout(() => evalRuns.delete(id), 60_000).unref();
          } finally {
            if (!evalRuns.get(id)?.failed) evalRuns.delete(id);
            await rm(join(dir, "eval-scratch"), { recursive: true, force: true }).catch(() => undefined);
          }
        })();
        return json(res, 202, {});
      }
      if (patch) {
        const got = await shop.patch(patch[1] as string);
        return got ? json(res, 200, got) : json(res, 404, { error: "not_found" });
      }
      const parsed = BuildBody.safeParse(await readJson(req));
      const base = decisions ? await resolveResearch(opts.researchDir) : null;
      if (!parsed.success || !decisions || !base) return json(res, 400, { error: "invalid_request" });
      const finding = await readFinding(base, parsed.data.findingId);
      if (!finding) return json(res, 404, { error: "not_found" });
      if ((await decisions.all()).get(finding.id)?.status !== "adopt") return json(res, 409, { reason: "not_adopted" });
      const fit = (await readEvaluations(base)).get(finding.id);
      const prepared = await shop.prepare(finding.id, finding.title);
      const brief = (await readBriefs(base)).get(finding.id);
      if (!prepared.ok) return json(res, prepared.code === "too_big" ? 413 : prepared.code === "too_many_builds" ? 429 : prepared.code === "copy_failed" ? 500 : 400, { error: prepared.code });
      const started = await opts.supervisor?.startMaster({ cwd: prepared.work, prompt: buildWorkshopGoal(finding, fit, opts.workshopTargetName ?? "the workspace", brief), workshop: prepared.build.id });
      if (!started?.ok) await shop.discard(prepared.build.id); // no master, so the copy is not kept
      else if (brief) await shop.writeEvals(prepared.build.id, evalsJson(brief)).catch(() => log({ event: "workshop-evals-error", build: prepared.build.id }));
      if (!started) return json(res, 404, { error: "not_found" });
      if (!started.ok) return json(res, started.status, started.status === 409 ? { reason: started.code } : { error: started.code });
      return json(res, 202, { id: started.id, build: prepared.build.id });
    });
    return true;
  }

  /** The Research department's routes. Returns false for a path that is not one of them. */
  function researchRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, method: string): boolean {
    const decision = FINDING_DECISION.exec(pathname);
    const evaluate = FINDING_EVALUATE.exec(pathname);
    const brief = FINDING_BRIEF.exec(pathname);
    const known =
      (pathname === "/api/research/findings" && method === "GET") ||
      (pathname === "/api/research/config" && (method === "GET" || method === "POST")) ||
      (pathname === "/api/research/sweep" && method === "POST" && opts.supervisor) ||
      (pathname === "/api/research/schedule" && (method === "GET" || method === "POST")) ||
      (decision && method === "POST") ||
      (evaluate && method === "POST" && opts.supervisor) ||
      (brief && method === "POST" && (brief[2] !== undefined || opts.supervisor));
    if (!known) return false;
    run(req, res, async () => {
      const base = decisions ? await resolveResearch(opts.researchDir) : null;
      if (!decisions || !base) return json(res, 400, { error: "no_research_folder" });
      if (pathname === "/api/research/findings") {
        const { findings, invalid } = await readFindings(base);
        const fits = await readEvaluations(base);
        const briefs = await readBriefs(base);
        return json(res, 200, { findings: withDecisions(findings, await decisions.all()).map((f) => ({ ...f, ...(fits.has(f.id) ? { fit: fits.get(f.id) } : {}), ...(briefs.has(f.id) ? { brief: briefs.get(f.id) } : {}) })), invalid });
      }
      if (brief) {
        const id = brief[1] as string;
        if (!SLUG.test(id)) return json(res, 400, { error: "invalid_request" });
        const finding = await readFinding(base, id);
        if (!finding) return json(res, 404, { error: "not_found" });
        const existing = (await readBriefs(base)).get(id);
        if (brief[2] !== undefined) {
          // The owner's edit: checked by the same rules as a model's brief, then written by the server.
          const parsed = BriefEdit.safeParse(await readJson(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_request" });
          if (!existing) return json(res, 404, { error: "not_found" });
          const edited: Brief = { id, goal: parsed.data.goal.trim(), files: parsed.data.files.trim(), criteria: parsed.data.criteria.trim(), date: new Date().toISOString().slice(0, 10), written_by: "owner", cases: parsed.data.cases.map((c) => ({ prompt: c.prompt.trim(), assertions: c.assertions.map((a) => a.trim()) })) };
          const checked = checkBrief(edited);
          if (!checked) return json(res, 400, { error: "invalid_input" });
          await saveBrief(base, checked);
          return json(res, 200, { brief: checked });
        }
        if (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined) {
          if (!z.object({}).strict().safeParse(await readJson(req)).success) return json(res, 400, { error: "invalid_request" });
        } else req.resume();
        if ((await decisions.all()).get(id)?.status !== "adopt") return json(res, 409, { reason: "not_adopted" });
        if (existing) return json(res, 409, { reason: "exists" });
        const fit = (await readEvaluations(base)).get(id);
        const result = await opts.supervisor?.startBrief(id, buildBriefPrompt(finding, fit, new Date().toISOString().slice(0, 10)));
        if (!result) return json(res, 404, { error: "not_found" });
        if (!result.ok) return json(res, result.status, result.status === 409 ? { reason: result.code } : { error: result.code });
        return json(res, 202, { id: result.id });
      }
      if (evaluate) {
        const id = evaluate[1] as string;
        if (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined) {
          if (!z.object({}).strict().safeParse(await readJson(req)).success) return json(res, 400, { error: "invalid_request" });
        } else req.resume();
        if (!SLUG.test(id)) return json(res, 400, { error: "invalid_request" });
        const finding = await readFinding(base, id);
        if (!finding) return json(res, 404, { error: "not_found" });
        const today = new Date().toISOString().slice(0, 10);
        const result = await opts.supervisor?.startEvaluation(id, buildEvaluationPrompt(finding, today));
        if (!result) return json(res, 404, { error: "not_found" });
        if (!result.ok) return json(res, result.status, result.status === 409 ? { reason: result.code } : { error: result.code });
        return json(res, 202, { id: result.id });
      }
      if (decision) {
        const id = decision[1] as string;
        const parsed = DecisionBody.safeParse(await readJson(req));
        if (!parsed.success || !SLUG.test(id)) return json(res, 400, { error: "invalid_request" });
        if (!(await readFinding(base, id))) return json(res, 404, { error: "not_found" });
        if ((await decisions.set(id, parsed.data)) === "full") return json(res, 400, { error: "too_many_decisions" });
        return json(res, 200, { id, status: parsed.data.status, ...(parsed.data.note ? { note: parsed.data.note } : {}) });
      }
      if (pathname === "/api/research/config") {
        if (method === "GET") return json(res, 200, await readConfig(base));
        const parsed = ConfigBody.safeParse(await readJson(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_request" });
        await writeConfig(base, parsed.data);
        return json(res, 200, await readConfig(base));
      }
      if (pathname === "/api/research/schedule") {
        if (!opts.scheduler) return json(res, 404, { error: "not_found" });
        if (method === "GET") return json(res, 200, await opts.scheduler.view());
        const parsed = ModeBody.safeParse(await readJson(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_request" });
        return json(res, 200, await opts.scheduler.setMode(parsed.data.mode));
      }
      // The sweep: no body, or an empty object.
      if (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined) {
        if (!z.object({}).strict().safeParse(await readJson(req)).success) return json(res, 400, { error: "invalid_request" });
      } else req.resume();
      const result = await opts.supervisor?.startSweep(await sweepPromptFor(base, decisions, Date.now(), opts.digest));
      if (!result) return json(res, 404, { error: "not_found" });
      if (!result.ok) return json(res, result.status, result.status === 409 ? { reason: result.code } : { error: result.code });
      json(res, 202, { id: result.id });
    });
    return true;
  }

  async function startWorker(req: http.IncomingMessage, res: http.ServerResponse) {
    const parsed = StartBody.safeParse(await readJson(req));
    if (!parsed.success) return json(res, 400, { error: "invalid_request" });
    const { role, cwd, team, prompt, name } = parsed.data;
    const request = { prompt, ...(name === undefined ? {} : { name }) };
    const result = await (role === "master"
      ? opts.supervisor?.startMaster({ ...request, ...(cwd === undefined ? {} : { cwd }), ...(team === undefined ? {} : { team }) })
      : opts.supervisor?.start({ ...request, cwd: cwd as string }));
    if (!result) return json(res, 404, { error: "not_found" });
    // A conflict says why in `reason`; every other refusal is an `error` code.
    if (!result.ok) return json(res, result.status, result.status === 409 ? { reason: result.code } : { error: result.code });
    json(res, 201, { id: result.id });
  }

  function openStream(res: http.ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const registry = opts.registry;
    // The snapshot goes first and the subscription follows in the same tick, so no change is missed.
    if (registry) writeEvent(res, { type: "snapshot", agents: registry.snapshot() });
    const unsubscribe = registry?.subscribe((event) => writeEvent(res, event));
    const beat = () => res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    beat();
    const timer = setInterval(beat, heartbeatMs);
    streams.add(res);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe?.();
      streams.delete(res);
    });
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return deny(res, 400, "bad-path", req);
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return deny(res, 400, "bad-path", req);

    const file = resolve(root, "." + (decoded === "/" ? "/index.html" : decoded));
    if (file !== root && !file.startsWith(root + sep)) return deny(res, 403, "traversal", req);

    try {
      if (!(await stat(file)).isFile()) return deny(res, 404, "not-found", req);
    } catch {
      return deny(res, 404, "not-found", req);
    }
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Security-Policy": CSP });
    if (req.method === "HEAD") return res.end();
    // pipeline handles a read error (for example a rebuild mid-request) instead of crashing.
    pipeline(createReadStream(file), res, (err) => {
      if (err) log({ event: "static-error", path: pathOf(req) });
    });
  }

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4777, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  const port = address.port;
  for (const p of [port, opts.publicPort]) {
    if (p === undefined) continue;
    allowedHosts.add(`127.0.0.1:${p}`);
    allowedHosts.add(`localhost:${p}`);
  }

  return {
    server,
    port,
    token,
    close: () =>
      new Promise<void>((done) => {
        for (const s of streams) s.end();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function writeEvent(res: http.ServerResponse, event: ServerEvent) {
  if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function pathOf(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0] ?? "";
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** True for prefetch/prerender and any other request that is not a top-level page navigation. */
function isPreload(req: http.IncomingMessage): boolean {
  const h = req.headers;
  const mode = h["sec-fetch-mode"];
  const dest = h["sec-fetch-dest"];
  return (
    h["sec-purpose"] !== undefined ||
    String(h["purpose"]).toLowerCase() === "prefetch" ||
    (mode !== undefined && mode !== "navigate") ||
    (dest !== undefined && dest !== "document")
  );
}

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
