import assert from "node:assert/strict";
import { readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkshop, type Workshop } from "../src/workshop.ts";
import { startServer, type RunningServer } from "../src/app.ts";
import { ensureResearchLayout } from "../src/findings.ts";
import { createGithub } from "../src/github.ts";
import { GITHUB_SERVER, GITHUB_TOOL_NAMES } from "../src/githubTools.ts";
import { WORKER_TOOLS } from "../src/lockdown.ts";
import { OFFICE_SERVER, OFFICE_TOOL_NAMES } from "../src/officeTools.ts";
import { createRegistry } from "../src/registry.ts";
import { RESEARCH_LEAD_PROMPT, RESEARCHER_PROMPT } from "../src/research.ts";
import { MAX_KNOWN, SWEEP_CAP_NOTE } from "../src/sweep.ts";
import { createSupervisor, type SupervisorOptions } from "../src/supervisor.ts";
import { createFake, resultMessage } from "./fakeQuery.ts";
import { loginTo, send, validPlan } from "./helpers.ts";

const SECRET = "BODY-SECRET-77c1d";
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fields = (id: string, over: Record<string, string> = {}) => ({
  id, kind: "repo", title: `Title of ${id}`, url: `https://github.com/x/${id}`, stars: "50", license: "MIT", relevance: "3",
  effort: "low", risk: "low", found_by: "repo-scout", date: "2026-11-01", why: `Why ${id} helps.`, ...over,
});
const noteText = (f: Record<string, string>, body = `${SECRET}\n`) => `---\n${Object.entries(f).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;

async function rig(opts: { research?: boolean; supervisor?: Partial<SupervisorOptions>; workshop?: Workshop } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "department-")));
  dirs.push(root);
  const research = join(root, "vault", "research");
  const data = join(root, "data");
  const staticDir = join(root, "dist");
  mkdirSync(research, { recursive: true });
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "x");
  if (opts.research !== false) await ensureResearchLayout(research);
  const registry = createRegistry();
  const logs: Record<string, unknown>[] = [];
  const f = createFake();
  const supervisor = createSupervisor({
    registry,
    query: f.query,
    roots: [research, ...(opts.workshop ? [opts.workshop.dir] : [])],
    ...(opts.workshop ? { onWorkshopEnd: async (b: string, final: boolean) => void (await opts.workshop?.finish(b, final)) } : {}),
    ...(opts.research === false ? {} : { researchDir: research }),
    github: createGithub({ token: "t", fetch: (async () => new Response("{}")) as unknown as typeof fetch }),
    env: { PATH: "p" },
    stopGraceMs: 150,
    startTimeoutMs: 600,
    log: (l) => logs.push(l),
    ...opts.supervisor,
  });
  closers.push(() => supervisor.close());
  const srv: RunningServer = await startServer({
    port: 0, staticDir, registry, supervisor, log: () => {},
    ...(opts.workshop ? { workshop: opts.workshop, workshopTargetName: "target" } : {}),
    ...(opts.research === false ? {} : { researchDir: research, dataDir: data }),
  });
  closers.push(() => srv.close());
  const auth = await loginTo(srv);
  const headers = (more: Record<string, string> = {}) => ({ host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json", ...more });
  const get = (path: string) => send(srv.port, path, { headers: { host: auth.host, cookie: auth.cookie } });
  const post = (path: string, body?: unknown, more: Record<string, string> = {}) =>
    send(srv.port, path, { method: "POST", headers: headers(more), ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const write = (id: string, over: Record<string, string> = {}, body?: string) => writeFileSync(join(research, "findings", `${id}.md`), noteText(fields(id, over), body));
  return { root, research, data, registry, logs, supervisor, srv, auth, get, post, write, headers, ...f };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 15));
  assert.ok(check(), "condition met");
}
const promptOf = (r: Rig, session = 0) => String((r.sessions[session]?.prompts[0]?.message as { content: unknown }).content);
async function officeOf(r: Rig, session = 0) {
  const s = r.calls[session]?.mcpServers?.[OFFICE_SERVER] as { instance: { connect(t: unknown): Promise<void> } };
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

describe("research routes: guard and folder (D1)", () => {
  const ROUTES: [string, string][] = [["GET", "/api/research/findings"], ["POST", "/api/research/findings/a-b/decision"], ["GET", "/api/research/config"], ["POST", "/api/research/config"], ["POST", "/api/research/sweep"]];

  it("refuses every route without the session cookie and with a foreign origin", async () => {
    const r = await rig();
    for (const [method, path] of ROUTES) {
      const bare = await send(r.srv.port, path, { method, headers: { host: r.auth.host, origin: `http://${r.auth.host}`, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined as unknown as string });
      assert.equal(bare.status, 403, `${method} ${path}`);
    }
    const foreign = await send(r.srv.port, "/api/research/sweep", { method: "POST", headers: r.headers({ origin: "http://evil.example" }), body: "{}" });
    assert.equal(foreign.status, 403);
    assert.equal(r.calls.length, 0);
  });

  it("answers 400 no_research_folder on every route when there is no research folder", async () => {
    const r = await rig({ research: false });
    for (const [method, path] of ROUTES) {
      const res = method === "GET" ? await r.get(path) : await r.post(path, {});
      assert.deepEqual([res.status, json(res)], [400, { error: "no_research_folder" }], `${method} ${path}`);
    }
  });

  it("answers 400 no_research_folder when the folder was deleted after startup", async () => {
    const r = await rig();
    rmSync(r.research, { recursive: true, force: true });
    assert.deepEqual([(await r.get("/api/research/findings")).status, json(await r.get("/api/research/config"))], [400, { error: "no_research_folder" }]);
  });

  it("does not know other methods or paths", async () => {
    const r = await rig();
    assert.equal((await r.post("/api/research/findings", {})).status, 404);
    assert.equal((await r.get("/api/research/sweep")).status, 404);
    assert.equal((await r.get("/api/research/findings/a-b/decision")).status, 404);
  });
});

describe("GET /api/research/findings (D1)", () => {
  it("lists findings newest first with status new, the invalid count, and never any body text", async () => {
    const r = await rig();
    r.write("older", { date: "2026-10-01", stars: "7" }, `${SECRET} old\n`);
    r.write("newer", { date: "2026-11-02" });
    r.write("nostars", { date: "2026-10-15", kind: "idea" });
    writeFileSync(join(r.research, "findings", "nostars.md"), noteText({ ...fields("nostars", { date: "2026-10-15", kind: "idea" }), stars: "", license: "" }));
    writeFileSync(join(r.research, "findings", "broken.md"), "nothing");
    const res = await r.get("/api/research/findings");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json");
    assert.deepEqual(json(res), {
      findings: [
        { id: "newer", kind: "repo", title: "Title of newer", url: "https://github.com/x/newer", stars: 50, license: "MIT", relevance: 3, effort: "low", risk: "low", found_by: "repo-scout", date: "2026-11-02", why: "Why newer helps.", status: "new" },
        { id: "nostars", kind: "idea", title: "Title of nostars", url: "https://github.com/x/nostars", relevance: 3, effort: "low", risk: "low", found_by: "repo-scout", date: "2026-10-15", why: "Why nostars helps.", status: "new" },
        { id: "older", kind: "repo", title: "Title of older", url: "https://github.com/x/older", stars: 7, license: "MIT", relevance: 3, effort: "low", risk: "low", found_by: "repo-scout", date: "2026-10-01", why: "Why older helps.", status: "new" },
      ],
      invalid: 1,
    });
    assert.equal(res.body.includes(SECRET), false);
  });

  it("is empty before any note exists", async () => {
    const r = await rig();
    assert.deepEqual(json(await r.get("/api/research/findings")), { findings: [], invalid: 0 });
  });
});

describe("POST /api/research/findings/:id/decision (D1)", () => {
  it("stores a decision, answers with it, and shows it on the next list", async () => {
    const r = await rig();
    r.write("one");
    const res = await r.post("/api/research/findings/one/decision", { status: "adopt", note: "try next week" });
    assert.deepEqual([res.status, json(res)], [200, { id: "one", status: "adopt", note: "try next week" }]);
    const list = json(await r.get("/api/research/findings")) as { findings: { status: string; note?: string }[] };
    assert.deepEqual([list.findings[0]?.status, list.findings[0]?.note], ["adopt", "try next week"]);
    const stored = JSON.parse(readFileSync(join(r.data, "research-decisions.json"), "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.decisions["one"].status, "adopt");
    const back = await r.post("/api/research/findings/one/decision", { status: "new" });
    assert.deepEqual(json(back), { id: "one", status: "new" });
    assert.equal(((json(await r.get("/api/research/findings")) as { findings: { note?: string }[] }).findings[0] as { note?: string }).note, undefined);
  });

  it("answers 404 for a finding without a valid file, including a file whose id does not match its name", async () => {
    const r = await rig();
    writeFileSync(join(r.research, "findings", "liar.md"), noteText(fields("someone-else")));
    for (const id of ["missing", "liar"]) {
      assert.deepEqual([(await r.post(`/api/research/findings/${id}/decision`, { status: "adopt" })).status], [404], id);
    }
    assert.equal(existsSync(join(r.data, "research-decisions.json")), false);
  });

  it("answers 400 for a bad id, status, note, extra key or body, and 415 / 413 like the other routes", async () => {
    const r = await rig();
    r.write("one");
    const url = "/api/research/findings/one/decision";
    for (const body of [{ status: "maybe" }, {}, { status: "adopt", extra: 1 }, { status: "adopt", note: "x".repeat(301) }, { status: "adopt", note: "bad\u0007" }, { status: "adopt", note: 5 }, [], "null"]) {
      assert.equal((await r.post(url, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await r.post(url, "{broken")).status, 400);
    for (const id of ["One", "-a", "a_b", "a.b", "x".repeat(81)]) assert.equal((await r.post(`/api/research/findings/${id}/decision`, { status: "adopt" })).status, 400, id);
    assert.equal((await r.post(url, { status: "adopt" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await r.post(url, { status: "adopt", note: "x".repeat(70_000) })).status, 413);
    assert.equal((await r.post(`/api/research/findings/..%2Fone/decision`, { status: "adopt" })).status, 400);
    assert.equal(existsSync(join(r.data, "research-decisions.json")), false, "nothing was stored");
  });

  it("answers 400 too_many_decisions at 1000 entries", async () => {
    const r2 = await rig();
    r2.write("one");
    mkdirSync(r2.data, { recursive: true });
    const decisions = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`n${i}`, { status: "later", updatedAt: "2026-11-05T00:00:00.000Z" }]));
    writeFileSync(join(r2.data, "research-decisions.json"), JSON.stringify({ version: 1, decisions }));
    const res = await r2.post("/api/research/findings/one/decision", { status: "adopt" });
    assert.deepEqual([res.status, json(res)], [400, { error: "too_many_decisions" }]);
  });
});

describe("GET and POST /api/research/config (D1)", () => {
  it("reads the defaults the server created, and writes both notes inside the research folder only", async () => {
    const r = await rig();
    const first = json(await r.get("/api/research/config")) as { focus: string[]; needs: string };
    assert.equal(first.focus.length, 4);
    assert.match(first.focus[0] as string, /claude skills/);
    assert.match(first.needs, /3D workspace/);
    const res = await r.post("/api/research/config", { focus: ["topic a", "topic b"], needs: "We need X.\nAnd Y." });
    assert.deepEqual([res.status, json(res)], [200, { focus: ["topic a", "topic b"], needs: "We need X.\nAnd Y." }]);
    assert.equal(readFileSync(join(r.research, "focus.md"), "utf8"), "topic a\ntopic b\n");
    assert.equal(readFileSync(join(r.research, "office-needs.md"), "utf8"), "We need X.\nAnd Y.\n");
    assert.deepEqual(json(await r.get("/api/research/config")), { focus: ["topic a", "topic b"], needs: "We need X.\nAnd Y." });
  });

  it("refuses bad shapes: too many or too long lines, line breaks inside a line, extra keys, long needs", async () => {
    const r = await rig();
    const ok = { focus: ["a"], needs: "n" };
    for (const body of [
      { ...ok, focus: Array.from({ length: 21 }, (_, i) => `t${i}`) }, { ...ok, focus: ["x".repeat(101)] }, { ...ok, focus: ["two\nlines"] },
      { ...ok, focus: [""] }, { ...ok, focus: ["# heading"] }, { ...ok, focus: ["bad\u0007"] }, { ...ok, needs: "x".repeat(4001) }, { ...ok, needs: "bad\u0000" },
      { ...ok, extra: 1 }, { focus: ["a"] }, { needs: "n" }, { focus: "a", needs: "n" },
    ]) {
      assert.equal((await r.post("/api/research/config", body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(readFileSync(join(r.research, "focus.md"), "utf8").includes("claude skills"), true, "nothing was written");
    assert.equal((await r.post("/api/research/config", { focus: Array.from({ length: 20 }, () => "x".repeat(100)), needs: "n".repeat(4000) })).status, 200, "limits are inclusive");
  });

  it("does not write through a link: a note that points outside is replaced, the target stays", async (t) => {
    const r = await rig();
    const outside = join(r.root, "outside.txt");
    writeFileSync(outside, "untouched");
    rmSync(join(r.research, "focus.md"));
    try {
      symlinkSync(outside, join(r.research, "focus.md"), "file");
    } catch {
      return t.skip("file links are not allowed on this machine");
    }
    assert.equal((await r.post("/api/research/config", { focus: ["x"], needs: "y" })).status, 200);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
  });
});

describe("POST /api/research/sweep (D2)", () => {
  it("starts the Lead in the research folder with a prompt built from the focus, needs, known findings and the format", async () => {
    const r = await rig();
    await r.post("/api/research/config", { focus: ["agent memory", "code review mcp"], needs: "Needs line ONE.\nNeeds line TWO." });
    r.write("kept", { title: "Kept project", date: "2026-11-02" });
    r.write("rejected", { title: "Rejected project", date: "2026-11-01" });
    r.write("adopted", { title: "Adopted project", date: "2026-10-30" });
    await r.post("/api/research/findings/rejected/decision", { status: "reject", note: "too heavy" });
    await r.post("/api/research/findings/adopted/decision", { status: "adopt" });
    const res = await r.post("/api/research/sweep");
    assert.equal(res.status, 202);
    const id = json(res)["id"] as string;
    assert.equal(r.registry.get(id)?.team, "research");
    assert.equal(r.registry.get(id)?.role, "master");
    assert.equal(r.calls[0]?.cwd, realpathSync(r.research));
    const prompt = promptOf(r);
    for (const part of [
      "- agent memory", "- code review mcp", "Needs line ONE.\nNeeds line TWO.",
      "- https://github.com/x/kept | Kept project | new", "- https://github.com/x/rejected | Rejected project | reject (too heavy)", "- https://github.com/x/adopted | Adopted project | adopt",
      "Never propose any of these again", "findings/<slug>.md", "never overwrite", "at most 10 new findings", "Write at most 10",
      "id:", "kind: <skill | mcp | repo | idea | technique>", "relevance: <whole number 1-5", "why: <one line", "found_by:", "---",
      "repo-scout, skills-mcp-scout, ideas-scout, integration-analyst", "up to 4 researchers", "licence, maintenance and permission risks", "Never install",
      "untrusted data", `sweeps/${new Date().toISOString().slice(0, 10)}-sweep.md`, "Stars must come from the GitHub tools",
    ]) {
      assert.ok(prompt.toLowerCase().includes(part.toLowerCase()), part);
    }
    assert.equal(prompt.includes(SECRET), false, "no note body reaches the prompt");
  });

  it("lists at most 150 known findings, newest first, and says how many were left out", async () => {
    const r = await rig();
    for (let i = 0; i < MAX_KNOWN + 7; i++) r.write(`f${String(i).padStart(3, "0")}`, { date: `2026-${i < 100 ? "09" : "10"}-${String((i % 28) + 1).padStart(2, "0")}` });
    assert.equal((await r.post("/api/research/sweep", {})).status, 202);
    const prompt = promptOf(r);
    assert.equal(prompt.split("\n").filter((l) => l.startsWith("- https://github.com/x/")).length, MAX_KNOWN);
    assert.match(prompt, /\(7 older findings are not listed/);
    assert.ok(prompt.includes("- https://github.com/x/f100 |"), "a newer item is listed");
    assert.equal(prompt.includes("https://github.com/x/f000 |") && prompt.includes("https://github.com/x/f099 |") && prompt.includes("https://github.com/x/f098 |"), false, "the oldest are left out");
  });

  it("has an empty known list and an empty-focus fallback on a fresh folder", async () => {
    const r = await rig();
    await r.post("/api/research/config", { focus: [], needs: "" });
    assert.equal((await r.post("/api/research/sweep")).status, 202);
    assert.match(promptOf(r), /\(nothing yet\)/);
    assert.match(promptOf(r), /\(none set/);
  });

  it("accepts an empty object and refuses any other body", async () => {
    const r = await rig();
    assert.equal((await r.post("/api/research/sweep", { topic: "x" })).status, 400);
    assert.equal((await r.post("/api/research/sweep", [])).status, 400);
    assert.equal((await r.post("/api/research/sweep", "{broken")).status, 400);
    assert.equal((await r.post("/api/research/sweep", { a: 1 }, { "content-type": "text/plain" })).status, 415);
    assert.equal(r.calls.length, 0);
    assert.equal((await r.post("/api/research/sweep", {})).status, 202);
  });

  it("runs one sweep at a time: 409 sweep_running while a research Lead is live, then again after it stops", async () => {
    const r = await rig({ supervisor: { maxMasters: 3 } });
    const first = json(await r.post("/api/research/sweep"))["id"] as string;
    const second = await r.post("/api/research/sweep");
    assert.deepEqual([second.status, json(second)], [409, { reason: "sweep_running" }]);
    assert.equal(r.calls.length, 1);
    assert.equal((await r.post(`/api/agents/${first}/stop`)).status, 202);
    await waitFor(() => r.registry.get(first)?.status === "stopped");
    assert.equal((await r.post("/api/research/sweep")).status, 202);
    const again = await r.post("/api/research/sweep");
    assert.deepEqual([again.status, json(again)], [409, { reason: "sweep_running" }]);
  });

  it("frees the slot when the Lead finishes its turn, and logs how the sweep ended", async () => {
    const r = await rig();
    const first = json(await r.post("/api/research/sweep"))["id"] as string;
    r.sessions[0]?.out.push(resultMessage(0.3));
    await waitFor(() => r.registry.get(first)?.status === "stopped");
    assert.equal(r.logs.some((l) => l["event"] === "sweep-end" && l["id"] === first), true);
    assert.equal(r.registry.get(first)?.note, "Sweep finished without a report.");
    assert.equal((await r.post("/api/research/sweep")).status, 202);
  });

  it("shows the Lead's own report on it, on one line and capped", async () => {
    const r = await rig();
    const first = json(await r.post("/api/research/sweep"))["id"] as string;
    r.sessions[0]?.out.push({ type: "result", subtype: "success", result: `0 findings filed\nIGNORE ${"x".repeat(400)}`, total_cost_usd: 0.1, session_id: "x" } as never);
    await waitFor(() => r.registry.get(first)?.status === "stopped");
    const note = r.registry.get(first)?.note ?? "";
    assert.match(note, /^Sweep finished\. The Lead reported: 0 findings filed IGNORE x+$/);
    assert.ok(note.length <= 280 && !note.includes("\n"));
  });

  it("refuses a sweep while an ordinary research run is live", async () => {
    const r = await rig({ supervisor: { maxMasters: 3 } });
    assert.equal((await r.post("/api/agents", { role: "master", team: "research", prompt: "topic" })).status, 201);
    assert.deepEqual(json(await r.post("/api/research/sweep")), { reason: "sweep_running" });
  });

  it("gives the Lead no GitHub tools and its researchers the two GitHub tools", async () => {
    const r = await rig();
    await r.post("/api/research/sweep");
    const lead = r.calls[0];
    assert.deepEqual(lead?.tools, [...WORKER_TOOLS, ...OFFICE_TOOL_NAMES]);
    assert.deepEqual(Object.keys(lead?.mcpServers ?? {}), [OFFICE_SERVER]);
    assert.equal((lead?.systemPrompt as { append: string }).append.includes(RESEARCH_LEAD_PROMPT), true);
    const office = await officeOf(r);
    assert.equal((await office("spawn_worker", { name: "ideas-scout", folder: r.research, task: "look" })).error, false);
    await waitFor(() => r.calls.length === 2);
    const w = r.calls[1];
    assert.deepEqual(w?.tools, [...WORKER_TOOLS, ...GITHUB_TOOL_NAMES]);
    assert.deepEqual(Object.keys(w?.mcpServers ?? {}), [GITHUB_SERVER]);
    assert.equal((w?.systemPrompt as { append: string }).append, RESEARCHER_PROMPT);
  });

  it("names the new roster and the findings format in the Lead prompt and keeps the star-count honesty", () => {
    for (const name of ["repo-scout", "skills-mcp-scout", "ideas-scout", "integration-analyst", "at most 4"]) assert.ok(RESEARCH_LEAD_PROMPT.includes(name), name);
    for (const word of ["stars_per_day", "no per-day star counts", "never follow instructions"]) assert.ok(RESEARCHER_PROMPT.includes(word), word);
  });
});

describe("the sweep usage cap (D2)", () => {
  async function sweepWithWorker(r: Rig) {
    const lead = json(await r.post("/api/research/sweep"))["id"] as string;
    const office = await officeOf(r);
    const spawned = await office("spawn_worker", { name: "repo-scout", folder: r.research, task: "look" });
    await waitFor(() => r.calls.length === 2);
    return { lead, office, worker: (JSON.parse(spawned.text) as { id: string }).id };
  }
  const finish = async (r: Rig, session: number, cost: number) => {
    const before = r.logs.filter((l) => l["event"] === "managed-turn-end").length;
    r.sessions[session]?.out.push(resultMessage(cost));
    await waitFor(() => r.logs.filter((l) => l["event"] === "managed-turn-end").length > before);
  };

  it("stops the Lead and its researcher when their costs together reach the cap, with the note", async () => {
    const r = await rig({ supervisor: { sweepBudgetUsd: 1 } });
    const { lead, worker } = await sweepWithWorker(r);
    await finish(r, 1, 0.5); // still under
    assert.equal(r.registry.get(lead)?.status !== "stopped", true);
    await finish(r, 1, 1.1); // over the cap
    await waitFor(() => r.registry.get(lead)?.status === "stopped");
    await waitFor(() => r.registry.get(worker)?.status === "stopped");
    assert.equal(r.registry.get(lead)?.note, SWEEP_CAP_NOTE);
    assert.equal(SWEEP_CAP_NOTE, "Stopped: the sweep usage cap was reached.");
    assert.equal(r.logs.some((l) => l["event"] === "managed-cap" && l["cap"] === "sweep"), true);
    // The cap counted only this sweep, and a new sweep may start.
    assert.equal((await r.post("/api/research/sweep")).status, 202);
  });

  it("defaults to $3 for the Lead and researchers together", async () => {
    const r = await rig();
    const { lead, office } = await sweepWithWorker(r);
    await office("spawn_worker", { name: "skills-scout", folder: r.research, task: "look" });
    await waitFor(() => r.calls.length === 3);
    await finish(r, 1, 1.9);
    await finish(r, 2, 1.0); // 2.9
    assert.notEqual(r.registry.get(lead)?.status, "stopped");
    await finish(r, 2, 1.2); // 3.1
    await waitFor(() => r.registry.get(lead)?.status === "stopped");
    assert.equal(r.registry.get(lead)?.note, SWEEP_CAP_NOTE);
  });

  it("starts each sweep from zero", async () => {
    const r = await rig({ supervisor: { sweepBudgetUsd: 1 } });
    const first = json(await r.post("/api/research/sweep"))["id"] as string;
    await finish(r, 0, 0.8); // the Lead's turn ends, which ends the sweep
    await waitFor(() => r.registry.get(first)?.status === "stopped");
    const second = json(await r.post("/api/research/sweep"))["id"] as string;
    await finish(r, 1, 0.8); // 0.8 + 0.8 would be over the cap if the first sweep's spending counted
    assert.equal(r.registry.get(second)?.note, "Sweep finished without a report."); // a normal end, not the cap note
  });

  it("does not apply to an ordinary research run, and the other caps keep working in a sweep", async () => {
    const plain = await rig({ supervisor: { sweepBudgetUsd: 1 } });
    const id = json(await plain.post("/api/agents", { role: "master", team: "research", prompt: "topic" }))["id"] as string;
    await finish(plain, 0, 1.5);
    assert.notEqual(plain.registry.get(id)?.status, "stopped");
    assert.equal(plain.registry.get(id)?.note ?? null, null);

    const r = await rig({ supervisor: { sweepBudgetUsd: 50, sessionBudgetUsd: 1.2 } });
    const lead = json(await r.post("/api/research/sweep"))["id"] as string;
    await finish(r, 0, 1.3); // over the session cap, far below the sweep cap
    await waitFor(() => r.registry.get(lead)?.status === "stopped");
    assert.match(r.registry.get(lead)?.note ?? "", /this session/);
  });
});

describe("the fit check (plan 15, R2)", () => {
  const report = (id: string, over: Record<string, string> = {}) =>
    `---\n${Object.entries({ id, verdict: "fits", how: "Add it to the skills folder", conflicts: "none", security: "Read-only, MIT", effort: "low", rollback: "Delete the folder", date: "2026-11-06", evaluated_by: "integration-analyst", ...over })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\nReasoning.\n`;
  const putReport = (r: Rig, id: string, text: string) => {
    mkdirSync(join(r.research, "evaluations"), { recursive: true });
    writeFileSync(join(r.research, "evaluations", `${id}.md`), text);
  };

  it("starts one read-only Evaluator in the research folder with the research worker's tools and a prompt that holds no note body", async () => {
    const r = await rig();
    r.write("tool-a", { title: "Tool A" });
    const res = await r.post("/api/research/findings/tool-a/evaluate");
    assert.equal(res.status, 202);
    const id = json(res)["id"] as string;
    const agent = r.registry.get(id);
    assert.deepEqual([agent?.role, agent?.team, agent?.name], ["worker", "research", "Evaluator tool-a"]);
    assert.equal(r.calls[0]?.cwd, realpathSync(r.research));
    assert.deepEqual(Object.keys(r.calls[0]?.mcpServers ?? {}), [GITHUB_SERVER]);
    const prompt = promptOf(r);
    for (const part of ["findings/tool-a.md", "evaluations/tool-a.md", "verdict: <fits | needs-work | doesnt-fit>", "never install", "never overwrite", "untrusted data"]) {
      assert.ok(prompt.toLowerCase().includes(part.toLowerCase()), part);
    }
    assert.equal(prompt.includes(SECRET), false);
  });

  it("refuses an unknown or badly named finding and a second Evaluator while one runs", async () => {
    const r = await rig({ supervisor: { maxManaged: 5 } });
    r.write("tool-a");
    r.write("tool-b");
    assert.equal((await r.post("/api/research/findings/nope/evaluate")).status, 404);
    assert.equal((await r.post("/api/research/findings/Bad_Name/evaluate")).status, 400);
    assert.equal((await r.post("/api/research/findings/tool-a/evaluate", { x: 1 })).status, 400);
    const first = json(await r.post("/api/research/findings/tool-a/evaluate"))["id"] as string;
    const second = await r.post("/api/research/findings/tool-b/evaluate");
    assert.deepEqual([second.status, json(second)], [409, { reason: "evaluating" }]);
    assert.equal((await r.post(`/api/agents/${first}/stop`)).status, 202);
    await waitFor(() => r.registry.get(first)?.status === "stopped");
    assert.equal((await r.post("/api/research/findings/tool-b/evaluate")).status, 202);
  });

  it("lets only one of two simultaneous requests start an Evaluator", async () => {
    const r = await rig({ supervisor: { maxManaged: 5 } });
    r.write("tool-a");
    r.write("tool-b");
    const [a, b] = await Promise.all([r.post("/api/research/findings/tool-a/evaluate"), r.post("/api/research/findings/tool-b/evaluate")]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    assert.equal(r.calls.length, 1);
  });

  it("gives the Evaluator's session a guard that allows only its own report file", async () => {
    const r = await rig();
    r.write("tool-a");
    assert.equal((await r.post("/api/research/findings/tool-a/evaluate")).status, 202);
    const hook = r.calls[0]?.hooks?.PreToolUse?.[0]?.hooks[0];
    assert.ok(hook);
    const allowed = async (file: string) => {
      const out = (await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file }, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: unknown };
      return out.hookSpecificOutput === undefined;
    };
    assert.equal(await allowed(join(realpathSync(r.research), "evaluations", "tool-a.md")), true);
    assert.equal(await allowed(join(realpathSync(r.research), "findings", "tool-a.md")), false);
  });

  it("shows a valid report on its finding and ignores a wrong id, a bad verdict and a two-line field", async () => {
    const r = await rig();
    for (const id of ["ok-one", "wrong-id", "bad-verdict", "two-lines"]) r.write(id);
    putReport(r, "ok-one", report("ok-one"));
    putReport(r, "wrong-id", report("someone-else"));
    putReport(r, "bad-verdict", report("bad-verdict", { verdict: "great" }));
    putReport(r, "two-lines", report("two-lines").replace("how: Add", "how: Add\nsecond line: x\nhow: Add"));
    const { findings } = json(await r.get("/api/research/findings")) as { findings: { id: string; fit?: { verdict: string; how: string } }[] };
    const byId = Object.fromEntries(findings.map((f) => [f.id, f.fit]));
    assert.deepEqual(byId["ok-one"], { id: "ok-one", verdict: "fits", how: "Add it to the skills folder", conflicts: "none", security: "Read-only, MIT", effort: "low", rollback: "Delete the folder", date: "2026-11-06", evaluated_by: "integration-analyst" });
    assert.equal(byId["wrong-id"], undefined);
    assert.equal(byId["bad-verdict"], undefined);
    assert.equal(byId["two-lines"], undefined);
  });
});

describe("the workshop (plan 15, R3)", () => {
  async function shopRig() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "shoprig-")));
    dirs.push(root);
    const target = join(root, "skills");
    mkdirSync(join(target, "docs"), { recursive: true });
    writeFileSync(join(target, "docs", "SKILL.md"), "base\n");
    const workshop = createWorkshop({ dir: join(root, "shop"), target });
    const r = await rig({ workshop });
    r.write("tool-a", { title: "Tool A" });
    return { ...r, workshop, target };
  }

  it("builds only an adopted finding, in a copy, with a plan-first master that is never auto-approved", async () => {
    const r = await shopRig();
    assert.deepEqual([(await r.post("/api/workshop/build", { findingId: "nope" })).status, (await r.post("/api/workshop/build", {})).status], [404, 400]);
    const refused = await r.post("/api/workshop/build", { findingId: "tool-a" });
    assert.deepEqual([refused.status, json(refused)], [409, { reason: "not_adopted" }]);
    assert.equal((await r.post("/api/research/findings/tool-a/decision", { status: "adopt" })).status, 200);
    const res = await r.post("/api/workshop/build", { findingId: "tool-a" });
    assert.equal(res.status, 202);
    const { id, build } = json(res) as { id: string; build: string };
    assert.equal(r.registry.get(id)?.phase, "planning");
    assert.equal(r.calls[0]?.cwd, join(realpathSync(r.workshop.dir), build, "b"));
    assert.ok(promptOf(r).includes("Tool A"));
    assert.ok(promptOf(r).includes("Build this improvement inside your folder"));
    assert.equal(readFileSync(join(r.target, "docs", "SKILL.md"), "utf8"), "base\n", "the target is untouched");
  });

  it("writes the patch when the master stops, and serves it", async () => {
    const r = await shopRig();
    await r.post("/api/research/findings/tool-a/decision", { status: "adopt" });
    const { id, build } = json(await r.post("/api/workshop/build", { findingId: "tool-a" })) as { id: string; build: string };
    writeFileSync(join(realpathSync(r.workshop.dir), build, "b", "docs", "SKILL.md"), "base\nmore\n");
    assert.equal((await r.post(`/api/agents/${id}/stop`)).status, 202);
    await waitFor(() => r.registry.get(id)?.status === "stopped");
    let listed: { builds: { id: string; status: string; changed: number }[] } = { builds: [] };
    for (let i = 0; i < 400 && listed.builds[0]?.status !== "ready"; i++) {
      listed = json(await r.get("/api/workshop")) as typeof listed;
      await new Promise((res) => setTimeout(res, 30));
    }
    assert.deepEqual([listed.builds[0]?.id, listed.builds[0]?.status, listed.builds[0]?.changed], [build, "ready", 1]);
    const patch = json(await r.get(`/api/workshop/${build}/patch`)) as { patch: string };
    assert.match(patch.patch, /^\+more$/m);
    assert.equal((await r.get("/api/workshop/aaaaaaaaaaaa/patch")).status, 404);
  });

  it("writes the patch at the end of a turn after approval, while the master is still running", async () => {
    const r = await shopRig();
    await r.post("/api/research/findings/tool-a/decision", { status: "adopt" });
    const { id, build } = json(await r.post("/api/workshop/build", { findingId: "tool-a" })) as { id: string; build: string };
    const call = await officeOf(r);
    assert.equal((await call("submit_plan", validPlan)).error, false);
    assert.equal((await r.post(`/api/agents/${id}/plan`, { decision: "approve" })).status, 202);
    writeFileSync(join(realpathSync(r.workshop.dir), build, "b", "docs", "SKILL.md"), "base\nedited\n");
    r.sessions[0]?.out.push(resultMessage(0.1));
    let status = "";
    for (let i = 0; i < 400 && status !== "ready"; i++) {
      status = ((json(await r.get("/api/workshop")) as { builds: { status: string }[] }).builds[0]?.status) ?? "";
      await new Promise((res) => setTimeout(res, 30));
    }
    assert.equal(status, "ready");
    assert.notEqual(r.registry.get(id)?.status, "stopped", "the master is still running");
  });

  it("keeps no copy when the master cannot start", async () => {
    const r = await shopRig();
    await r.post("/api/research/findings/tool-a/decision", { status: "adopt" });
    const first = await r.post("/api/workshop/build", { findingId: "tool-a" });
    assert.equal(first.status, 202);
    const second = await r.post("/api/workshop/build", { findingId: "tool-a" });
    assert.equal(second.status, 409);
    assert.equal(((json(await r.get("/api/workshop")) as { builds: unknown[] }).builds).length, 1);
    assert.equal(readdirSync(r.workshop.dir).length, 1, "no folder was left for the refused start");
  });

  it("answers 404 when the workshop is not set up", async () => {
    const r = await rig();
    assert.equal((await r.get("/api/workshop")).status, 404);
  });
});

describe("the implementation brief (plan 18, E1)", () => {
  const brief = (id: string) =>
    `---\nid: ${id}\ngoal: Add a checklist\nfiles: docs/SKILL.md\ncriteria: The skill lists the checks\ndate: 2026-11-09\nwritten_by: briefer\neval1_prompt: Review this README\neval1_expect: names accuracy | mentions links\neval2_prompt: Is my doc good\neval2_expect: gives a checklist\n---\nbody\n`;
  const putBrief = (r: Rig, id: string, text: string) => {
    mkdirSync(join(r.research, "briefs"), { recursive: true });
    writeFileSync(join(r.research, "briefs", `${id}.md`), text);
  };

  it("starts a Briefer only for an adopted finding, with the one-file guard, and refuses a second brief or a second writer", async () => {
    const r = await rig({ supervisor: { maxManaged: 5 } });
    r.write("tool-a", { title: "Tool A" });
    r.write("tool-b");
    const early = await r.post("/api/research/findings/tool-a/brief");
    assert.deepEqual([early.status, json(early)], [409, { reason: "not_adopted" }]);
    assert.equal((await r.post("/api/research/findings/nope/brief")).status, 404);
    await r.post("/api/research/findings/tool-a/decision", { status: "adopt" });
    await r.post("/api/research/findings/tool-b/decision", { status: "adopt" });
    const res = await r.post("/api/research/findings/tool-a/brief");
    assert.equal(res.status, 202);
    const agent = r.registry.get(json(res)["id"] as string);
    assert.deepEqual([agent?.role, agent?.team, agent?.name], ["worker", "research", "Briefer tool-a"]);
    assert.equal(r.calls[0]?.cwd, realpathSync(r.research));
    const prompt = promptOf(r);
    for (const part of ["findings/tool-a.md", "briefs/tool-a.md", "eval1_prompt", "never install", "untrusted"]) assert.ok(prompt.toLowerCase().includes(part.toLowerCase()), part);
    assert.equal(prompt.includes(SECRET), false);
    const hook = r.calls[0]?.hooks?.PreToolUse?.[0]?.hooks[0];
    assert.ok(hook);
    const allowed = async (file: string) => {
      const out = (await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file }, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: unknown };
      return out.hookSpecificOutput === undefined;
    };
    assert.equal(await allowed(join(realpathSync(r.research), "briefs", "tool-a.md")), true);
    assert.equal(await allowed(join(realpathSync(r.research), "findings", "tool-a.md")), false);
    assert.equal(await allowed(join(realpathSync(r.research), "briefs", "tool-b.md")), false);
    const busy = await r.post("/api/research/findings/tool-b/brief");
    assert.deepEqual([busy.status, json(busy)], [409, { reason: "evaluating" }], "one research writer at a time, shared with the fit check");
    putBrief(r, "tool-a", brief("tool-a"));
    const again = await r.post("/api/research/findings/tool-a/brief");
    assert.deepEqual([again.status, json(again)], [409, { reason: "exists" }]);
  });

  it("shows a valid brief on its finding, ignores a broken one, and lets the owner save an edit that is checked again", async () => {
    const r = await rig();
    r.write("tool-a");
    r.write("tool-b");
    putBrief(r, "tool-a", brief("tool-a"));
    putBrief(r, "tool-b", brief("tool-b").replace("eval2_prompt: Is my doc good\neval2_expect: gives a checklist\n", ""));
    const list = json(await r.get("/api/research/findings")) as { findings: { id: string; brief?: { goal: string; cases: unknown[] } }[] };
    const byId = Object.fromEntries(list.findings.map((f) => [f.id, f.brief]));
    assert.deepEqual([byId["tool-a"]?.goal, byId["tool-a"]?.cases.length, byId["tool-b"]], ["Add a checklist", 2, undefined]);
    const edit = { goal: "Add a better checklist", files: "docs/SKILL.md", criteria: "It lists the checks", cases: [{ prompt: "Review this", assertions: ["names accuracy"] }, { prompt: "Is this good", assertions: ["gives a list"] }] };
    const saved = await r.post("/api/research/findings/tool-a/brief/save", edit);
    assert.equal(saved.status, 200);
    const again = json(await r.get("/api/research/findings")) as typeof list;
    assert.equal(again.findings.find((f) => f.id === "tool-a")?.brief?.goal, "Add a better checklist");
    assert.match(readFileSync(join(r.research, "briefs", "tool-a.md"), "utf8"), /written_by: owner/);
    assert.equal((await r.post("/api/research/findings/tool-a/brief/save", { ...edit, cases: [edit.cases[0]] })).status, 400, "one case is not enough");
    assert.equal((await r.post("/api/research/findings/tool-a/brief/save", { ...edit, goal: "two\nlines" })).status, 400);
    assert.equal((await r.post("/api/research/findings/tool-a/brief/save", { ...edit, extra: 1 })).status, 400);
    r.write("no-brief");
    assert.equal((await r.post("/api/research/findings/no-brief/brief/save", edit)).status, 404);
  });

  it("gives the Workshop master the brief and keeps the eval cases next to the copies, out of the patch", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "briefshop-")));
    dirs.push(root);
    const target = join(root, "skills");
    mkdirSync(join(target, "docs"), { recursive: true });
    writeFileSync(join(target, "docs", "SKILL.md"), "base\n");
    const workshop = createWorkshop({ dir: join(root, "shop"), target });
    const r = await rig({ workshop });
    r.write("tool-a", { title: "Tool A" });
    putBrief(r, "tool-a", brief("tool-a"));
    await r.post("/api/research/findings/tool-a/decision", { status: "adopt" });
    const res = await r.post("/api/workshop/build", { findingId: "tool-a" });
    assert.equal(res.status, 202);
    const buildId = json(res)["build"] as string;
    const prompt = promptOf(r);
    assert.ok(prompt.includes("Brief from the research team") && prompt.includes("Add a checklist") && prompt.includes("Review this README"));
    const file = join(realpathSync(workshop.dir), buildId, "evals.json");
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((res2) => setTimeout(res2, 20));
    const evals = JSON.parse(readFileSync(file, "utf8")) as { evals: { assertions: string[] }[] };
    assert.deepEqual(evals.evals[0]?.assertions, ["names accuracy", "mentions links"]);
    assert.equal(existsSync(join(realpathSync(workshop.dir), buildId, "b", "evals.json")), false, "not inside the working copy");
  });
});

describe("the skill eval routes (plan 18, E2)", () => {
  const brief = (id: string) =>
    `---\nid: ${id}\ngoal: Add a checklist\nfiles: docs/SKILL.md\ncriteria: The skill lists the checks\ndate: 2026-11-09\nwritten_by: briefer\neval1_prompt: Review this README\neval1_expect: names accuracy | mentions links\neval2_prompt: Is my doc good\neval2_expect: gives a checklist\n---\nbody\n`;

  async function readyBuild(withBrief: boolean) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "evalrig-")));
    dirs.push(root);
    const target = join(root, "skills");
    mkdirSync(join(target, "docs"), { recursive: true });
    writeFileSync(join(target, "docs", "SKILL.md"), "---\nname: docs\ndescription: d\n---\nWrite short sentences.\n");
    const workshop = createWorkshop({ dir: join(root, "shop"), target });
    const r = await rig({ workshop, supervisor: { maxManaged: 12 } });
    r.write("tool-a", { title: "Tool A" });
    if (withBrief) {
      mkdirSync(join(r.research, "briefs"), { recursive: true });
      writeFileSync(join(r.research, "briefs", "tool-a.md"), brief("tool-a"));
    }
    await r.post("/api/research/findings/tool-a/decision", { status: "adopt" });
    const res = await r.post("/api/workshop/build", { findingId: "tool-a" });
    const { id, build } = json(res) as { id: string; build: string };
    const buildDir = join(realpathSync(workshop.dir), build);
    for (let i = 0; i < 100 && !existsSync(join(buildDir, "evals.json")) && withBrief; i++) await new Promise((x) => setTimeout(x, 20));
    return { ...r, id, build, buildDir, workshop };
  }

  /** Answers every eval session the fake query has started: graders pass every check on a GOOD answer, executors answer GOOD when the skill is in the prompt. */
  async function answerSessions(r: Awaited<ReturnType<typeof readyBuild>>, until: () => Promise<boolean>) {
    const done = new Set<number>([0]);
    for (let n = 0; n < 600 && !(await until()); n++) {
      for (let i = 1; i < r.sessions.length; i++) {
        const prompt = String((r.sessions[i]?.prompts[0]?.message as { content: unknown } | undefined)?.content ?? "");
        if (done.has(i) || prompt === "") continue;
        done.add(i);
        const checks = (prompt.match(/^\d+\. /gm) ?? []).length;
        const text = prompt.startsWith("You grade")
          ? JSON.stringify({ results: Array.from({ length: checks }, (_, k) => ({ check: k + 1, pass: prompt.includes("GOOD"), why: "judged" })) })
          : prompt.includes("Write short sentences.\nAlways add a checklist") ? "GOOD answer" : "plain answer";
        r.sessions[i]?.out.push({ type: "result", subtype: "success", result: text, total_cost_usd: 0.01, session_id: "x" } as never);
      }
      await new Promise((x) => setTimeout(x, 20));
    }
  }

  it("refuses until the build has a patch, the eval cases and a changed skill, and needs confirm", async () => {
    const r = await readyBuild(false);
    assert.equal((await r.post(`/api/workshop/${r.build}/eval`, {})).status, 400, "no confirm");
    const early = await r.post(`/api/workshop/${r.build}/eval`, { confirm: true });
    assert.deepEqual([early.status, json(early)], [409, { reason: "no_patch" }]);
    writeFileSync(join(r.buildDir, "b", "docs", "SKILL.md"), "---\nname: docs\ndescription: d\n---\nWrite short sentences.\nAlways add a checklist\n");
    await r.post(`/api/agents/${r.id}/stop`);
    for (let i = 0; i < 200 && ((json(await r.get("/api/workshop")) as { builds: { status: string }[] }).builds[0]?.status !== "ready"); i++) await new Promise((x) => setTimeout(x, 30));
    const noEvals = await r.post(`/api/workshop/${r.build}/eval`, { confirm: true });
    assert.deepEqual([noEvals.status, json(noEvals)], [409, { reason: "no_evals" }], "this build was made without a brief");
    assert.equal((await r.post("/api/workshop/aaaaaaaaaaaa/eval", { confirm: true })).status, 404);
    assert.equal((await r.get(`/api/workshop/${r.build}/eval`)).status, 404, "no result yet");
  });

  it("runs the eval in tool-less sessions, one at a time, saves the result with the build and shows it in the list", async () => {
    const r = await readyBuild(true);
    writeFileSync(join(r.buildDir, "b", "docs", "SKILL.md"), "---\nname: docs\ndescription: d\n---\nWrite short sentences.\nAlways add a checklist\n");
    await r.post(`/api/agents/${r.id}/stop`);
    for (let i = 0; i < 200 && ((json(await r.get("/api/workshop")) as { builds: { status: string }[] }).builds[0]?.status !== "ready"); i++) await new Promise((x) => setTimeout(x, 30));
    const started = await r.post(`/api/workshop/${r.build}/eval`, { confirm: true });
    assert.equal(started.status, 202);
    const again = await r.post(`/api/workshop/${r.build}/eval`, { confirm: true });
    assert.deepEqual([again.status, json(again)], [409, { reason: "eval_running" }]);
    const verdictShown = async () => ((json(await r.get("/api/workshop")) as { builds: { eval?: { verdict: string } }[] }).builds[0]?.eval?.verdict ?? "") !== "";
    await answerSessions(r, verdictShown);
    const list = json(await r.get("/api/workshop")) as { builds: { eval?: { verdict: string; delta: number; withRate: number; baselineRate: number }; evalRun?: unknown }[] };
    assert.deepEqual([list.builds[0]?.eval?.verdict, list.builds[0]?.eval?.withRate, list.builds[0]?.eval?.baselineRate, list.builds[0]?.eval?.delta], ["improves", 1, 0, 1]);
    assert.equal(list.builds[0]?.evalRun, undefined, "no longer running");
    const full = json(await r.get(`/api/workshop/${r.build}/eval`)) as { cases: { prompt: string }[]; baseline: string };
    assert.deepEqual([full.cases.length, full.baseline], [2, "previous version"]);
    // 1 master + 2 cases x (2 answers + 2 graders) = 9 sessions, and every eval session has no tools and few turns
    assert.equal(r.calls.length, 9);
    for (const call of r.calls.slice(1)) assert.deepEqual([call.tools, call.maxTurns], [[], 3]);
    assert.equal(existsSync(join(r.buildDir, "eval-scratch")), false, "the scratch folder is removed");
    assert.equal(existsSync(join(r.buildDir, "a", "docs", "SKILL.md")), true);
  });
});
