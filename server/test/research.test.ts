import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { startServer, type RunningServer } from "../src/app.ts";
import { checkToolCall } from "../src/folderGuard.ts";
import { createGithub } from "../src/github.ts";
import { GITHUB_SERVER, GITHUB_TOOL_NAMES } from "../src/githubTools.ts";
import { lockdownOptions, MAX_TURNS, WORKER_TOOLS } from "../src/lockdown.ts";
import { OFFICE_SERVER, OFFICE_TOOL_NAMES } from "../src/officeTools.ts";
import { createRegistry } from "../src/registry.ts";
import { RESEARCH_LEAD_PROMPT, RESEARCHER_PROMPT } from "../src/research.ts";
import { createSupervisor } from "../src/supervisor.ts";
import { createFake } from "./fakeQuery.ts";
import { loginTo, send } from "./helpers.ts";

const TOKEN = "ghp_SECRETTOKEN123";
const made: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function rig(opts: { research?: boolean } = {}) {
  // The long form of the path: on Windows the temp folder may be given by its short name, which real paths never use.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "research-")));
  made.push(root);
  const research = join(root, "vault", "research");
  const other = join(root, "other"); // allowed by the roots, but not the research folder
  mkdirSync(join(research, "sub"), { recursive: true });
  mkdirSync(other);
  const registry = createRegistry();
  const logs: Record<string, unknown>[] = [];
  const f = createFake();
  const fetched: URL[] = [];
  const github = createGithub({
    token: TOKEN,
    log: (l) => logs.push(l),
    fetch: (async (url: URL) => {
      fetched.push(url);
      return new Response(JSON.stringify({ items: [{ full_name: "a/b", stargazers_count: 9 }] }));
    }) as unknown as typeof fetch,
  });
  const supervisor = createSupervisor({
    registry,
    query: f.query,
    roots: [other, research], // only the research folder of the vault, as main.ts adds it
    ...(opts.research === false ? {} : { researchDir: research }),
    github,
    env: { PATH: "p", GITHUB_TOKEN: TOKEN },
    stopGraceMs: 150,
    startTimeoutMs: 400,
    log: (l) => logs.push(l),
  });
  closers.push(() => supervisor.close());
  return { root, research, other, registry, logs, supervisor, fetched, ...f };
}
type Rig = ReturnType<typeof rig>;

async function connect(r: Rig, session: number, server: string) {
  const s = r.calls[session]?.mcpServers?.[server] as { instance: { connect(t: unknown): Promise<void> } } | undefined;
  assert.ok(s, `session ${session} has the ${server} tool server`);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.instance.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  closers.push(() => client.close());
  return async (name: string, args: object = {}) => {
    const res = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: { text: string }[] };
    return { error: res.isError === true, text: res.content[0]?.text ?? "" };
  };
}

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 15));
  assert.ok(check(), "condition met");
}

/** A research master with one worker started through its own office tool. */
async function team(r: Rig) {
  const res = await r.supervisor.startMaster({ prompt: "topic", team: "research" });
  assert.ok(res.ok);
  const office = await connect(r, 0, OFFICE_SERVER);
  const spawned = await office("spawn_worker", { name: "repo-scout", folder: r.research, task: "find repos" });
  assert.equal(spawned.error, false, spawned.text);
  await waitFor(() => r.calls.length === 2);
  return { masterId: res.id, workerId: (JSON.parse(spawned.text) as { id: string }).id, office };
}

describe("the research team (R3, R4)", () => {
  it("starts in the research folder by default, marks the master and its workers, and gives the Lead no GitHub tools", async () => {
    const r = rig();
    const { masterId, workerId } = await team(r);
    assert.equal(r.registry.get(masterId)?.team, "research");
    assert.equal(r.registry.get(workerId)?.team, "research");
    assert.equal(r.calls[0]?.cwd, realpathSync(r.research));
    const lead = r.calls[0] as Options;
    assert.deepEqual(lead.tools, [...WORKER_TOOLS, ...OFFICE_TOOL_NAMES]);
    assert.deepEqual(Object.keys(lead.mcpServers ?? {}), [OFFICE_SERVER]);
    const prompt = lead.systemPrompt as { append: string };
    assert.ok(prompt.append.includes(RESEARCH_LEAD_PROMPT));
  });

  it("gives only the research team's workers the two GitHub tools, with a researcher prompt", async () => {
    const r = rig();
    await team(r);
    const w = r.calls[1] as Options;
    assert.deepEqual(w.tools, [...WORKER_TOOLS, ...GITHUB_TOOL_NAMES]);
    assert.deepEqual(w.allowedTools, [...WORKER_TOOLS, ...GITHUB_TOOL_NAMES]);
    assert.deepEqual(GITHUB_TOOL_NAMES, ["mcp__github__github_search_repos", "mcp__github__github_repo"]);
    assert.deepEqual(Object.keys(w.mcpServers ?? {}), [GITHUB_SERVER]);
    assert.deepEqual((w.systemPrompt as { append: string }).append, RESEARCHER_PROMPT);
    assert.equal(w.maxTurns, MAX_TURNS);
    for (const key of ["permissionMode", "settingSources", "strictMcpConfig", "disallowedTools", "maxBudgetUsd"] as const) {
      assert.deepEqual(w[key], lockdownOptions()[key], key);
    }
    // The folder guard lets these tools through.
    assert.deepEqual(await checkToolCall(r.research, GITHUB_TOOL_NAMES[0] as string, {}, GITHUB_TOOL_NAMES), { ok: true });
    assert.equal((await checkToolCall(r.research, GITHUB_TOOL_NAMES[0] as string, {})).ok, false);
  });

  it("gives no GitHub tools to an ordinary worker, an ordinary master, or the workers of an ordinary master", async () => {
    const r = rig();
    assert.ok((await r.supervisor.start({ cwd: r.other, prompt: "x" })).ok);
    assert.ok((await r.supervisor.startMaster({ cwd: r.other, prompt: "x" })).ok);
    const office = await connect(r, 1, OFFICE_SERVER);
    assert.equal((await office("spawn_worker", { name: "w", folder: r.other, task: "t" })).error, false);
    await waitFor(() => r.calls.length === 3);
    for (const [i, o] of r.calls.entries()) {
      const names = [...(o.tools as string[]), ...(o.allowedTools ?? [])];
      assert.ok(!names.some((n) => n.startsWith("mcp__github__")), `session ${i}`);
      assert.ok(!(GITHUB_SERVER in (o.mcpServers ?? {})), `session ${i}`);
    }
    assert.equal(r.registry.snapshot().filter((a) => a.team).length, 0);
  });

  it("answers the researcher's tool calls from GitHub, with the token nowhere in results, logs or the child's environment", async () => {
    const r = rig();
    await team(r);
    const gh = await connect(r, 1, GITHUB_SERVER);
    const ok = await gh("github_search_repos", { query: "mcp servers", sort: "stars", topic: "mcp-server", limit: 5 });
    assert.equal(ok.error, false);
    assert.equal((JSON.parse(ok.text) as { repos: { stars: number }[] }).repos[0]?.stars, 9);
    assert.equal(r.fetched[0]?.host, "api.github.com");
    // Strict schemas: a qualifier and a big limit are refused (the SDK takes a field list, so an unknown field is dropped, not passed on).
    for (const args of [{ query: "x stars:>5", sort: "stars" }, { query: "x", sort: "stars", limit: 50 }]) {
      assert.equal((await gh("github_search_repos", args)).error, true, JSON.stringify(args));
    }
    assert.equal((await gh("github_repo", { full_name: "a/b/../c" })).error, true);
    assert.equal(r.fetched.length, 1);
    const all = JSON.stringify([ok, r.logs, r.registry.snapshot(), r.calls.map((c) => c.env)]);
    assert.ok(!all.includes(TOKEN));
  });

  it("limits the app to 8 GitHub calls a minute and says when to try again", async () => {
    const r = rig();
    await team(r);
    const gh = await connect(r, 1, GITHUB_SERVER);
    for (let i = 0; i < 8; i++) assert.equal((await gh("github_search_repos", { query: `topic ${i}`, sort: "stars" })).error, false);
    const res = await gh("github_search_repos", { query: "one more", sort: "stars" });
    assert.equal(res.error, true);
    const body = JSON.parse(res.text) as { error: string; retry_after_s: number };
    assert.equal(body.error, "rate_limited");
    assert.ok(body.retry_after_s >= 1 && body.retry_after_s <= 60);
  });

  it("keeps the team inside the research folder", async () => {
    const r = rig();
    // A folder that is allowed by the roots but is not the research folder.
    assert.deepEqual(await r.supervisor.startMaster({ cwd: r.other, prompt: "x", team: "research" }), { ok: false, status: 403, code: "folder_not_allowed" });
    assert.equal(r.calls.length, 0);
    const { office } = await team(r);
    const outside = await office("spawn_worker", { name: "w", folder: r.other, task: "t" });
    assert.equal(outside.error, true);
    const inside = await office("spawn_worker", { name: "w2", folder: join(r.research, "sub"), task: "t" });
    assert.equal(inside.error, false, inside.text);
    // The files the team may write: the folder guard of the Lead's session denies a path outside it and allows one inside.
    assert.equal((await checkToolCall(realpathSync(r.research), "Write", { file_path: join(r.other, "x.md") })).ok, false);
    assert.equal((await checkToolCall(realpathSync(r.research), "Write", { file_path: join(r.research, "2026-11-05-topic.md") })).ok, true);
    const hook = r.calls[0]?.hooks?.PreToolUse?.[0]?.hooks[0];
    const out = await hook?.({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(r.other, "x.md") } } as never, undefined, { signal: new AbortController().signal });
    assert.equal((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, "deny");
  });

  it("refuses a research team when there is no research folder", async () => {
    const r = rig({ research: false });
    assert.deepEqual(await r.supervisor.startMaster({ prompt: "x", team: "research" }), { ok: false, status: 400, code: "no_research_folder" });
    assert.equal(r.calls.length, 0);
  });
});

describe("POST /api/agents with a team", () => {
  async function http() {
    const r = rig();
    const staticDir = join(r.root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<p>x</p>");
    const srv: RunningServer = await startServer({ port: 0, staticDir, registry: r.registry, supervisor: r.supervisor, log: () => {} });
    closers.push(() => srv.close());
    const auth = await loginTo(srv);
    const post = (body: unknown) =>
      send(srv.port, "/api/agents", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" },
      });
    return { r, post };
  }

  it("starts a research master without a folder", async () => {
    const { r, post } = await http();
    const res = await post({ role: "master", team: "research", prompt: "top mcp servers" });
    assert.equal(res.status, 201);
    assert.equal(r.registry.get((JSON.parse(res.body) as { id: string }).id)?.team, "research");
  });

  it("answers 400 invalid_request for a team on a worker, an unknown team, or a missing folder without a team", async () => {
    const { r, post } = await http();
    for (const body of [
      { role: "worker", team: "research", prompt: "x" },
      { role: "worker", team: "research", cwd: r.other, prompt: "x" },
      { role: "master", team: "marketing", prompt: "x" },
      { role: "master", prompt: "x" },
      { role: "worker", prompt: "x" },
    ]) {
      const res = await post(body);
      assert.deepEqual([res.status, JSON.parse(res.body)], [400, { error: "invalid_request" }], JSON.stringify(body));
    }
    assert.equal(r.calls.length, 0);
  });

  it("answers 400 no_research_folder when none is set", async () => {
    const r = rig({ research: false });
    const staticDir = join(r.root, "dist");
    mkdirSync(staticDir);
    const srv = await startServer({ port: 0, staticDir, registry: r.registry, supervisor: r.supervisor, log: () => {} });
    closers.push(() => srv.close());
    const auth = await loginTo(srv);
    const res = await send(srv.port, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ role: "master", team: "research", prompt: "x" }),
      headers: { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" },
    });
    assert.deepEqual([res.status, JSON.parse(res.body)], [400, { error: "no_research_folder" }]);
  });
});
