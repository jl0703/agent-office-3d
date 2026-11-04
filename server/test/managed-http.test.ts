import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor, type SupervisorOptions } from "../src/supervisor.ts";
import { saveStore } from "../src/managedStore.ts";
import { createFake, rateLimitMessage, resultMessage, storedWorker, type FakeOptions } from "./fakeQuery.ts";
import { loginTo, openStream, parse, send, type Stream } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
const closers: (() => Promise<void>)[] = [];
const streams: Stream[] = [];
after(async () => {
  for (const s of streams) s.close();
  await Promise.all(closers.map((close) => close()));
  await Promise.all(servers.map((s) => s.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function rig(fake: FakeOptions = {}, extra: Partial<SupervisorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "managed-http-"));
  dirs.push(root);
  const work = join(root, "demo");
  mkdirSync(work);
  const staticDir = join(root, "dist");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<p>x</p>");

  const registry = createRegistry();
  const logs: Record<string, unknown>[] = [];
  const f = createFake(fake);
  const supervisor = createSupervisor({
    registry,
    query: f.query,
    roots: [root],
    env: { PATH: "p" },
    stopGraceMs: 150,
    startTimeoutMs: 1000,
    dataDir: join(root, "data"),
    log: (line) => logs.push(line),
    ...extra,
  });
  closers.push(() => supervisor.close());
  const srv = await startServer({ port: 0, staticDir, registry, supervisor, log: () => {} });
  servers.push(srv);
  const auth = await loginTo(srv);

  const headers = (more: Record<string, string> = {}) => ({
    host: auth.host,
    cookie: auth.cookie,
    origin: `http://${auth.host}`,
    "content-type": "application/json",
    ...more,
  });
  const post = (path: string, body: unknown = {}, more: Record<string, string> = {}) =>
    send(srv.port, path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: headers(more) });
  const start = (body: object = {}) => post("/api/agents", { role: "worker", cwd: work, prompt: "do it", ...body });
  const stream = async () => {
    const s = await openStream(srv.port, { host: auth.host, cookie: auth.cookie });
    streams.push(s);
    return s;
  };
  /** Puts workers in the file and runs the startup recovery, like a restart. */
  const restartWith = async (...ids: string[]) => {
    await supervisor.settled(); // writes still queued would collide with this one
    await saveStore(join(root, "data"), ids.map((id) => storedWorker(id, { cwd: work })));
    await supervisor.recover();
  };
  /** Ends the turn of one session and waits until the server has seen it. */
  const endTurn = async (session: number, cost = 0.1) => {
    const before = logs.filter((l) => l["event"] === "managed-turn-end").length;
    f.sessions[session]?.out.push(resultMessage(cost));
    const end = Date.now() + 3000;
    while (logs.filter((l) => l["event"] === "managed-turn-end").length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };
  return { root, work, registry, supervisor, srv, auth, post, start, stream, headers, restartWith, endTurn, ...f };
}

describe("starting a worker over HTTP", () => {
  it("starts a worker and tells the browser about it", async () => {
    const r = await rig();
    const stream = await r.stream();
    const res = await r.start({ name: "Fixer" });
    assert.equal(res.status, 201);
    const { id } = JSON.parse(res.body) as { id: string };
    const spawned = parse(await stream.next((e) => e.name === "agent.spawned")) as { agent: { id: string; origin: string; name: string } };
    assert.equal(spawned.agent.id, id);
    assert.equal(spawned.agent.origin, "managed");
    assert.equal(spawned.agent.name, "Fixer");
  });

  it("refuses bad requests with a short code and never starts anything", async () => {
    const r = await rig();
    const cases: [string, unknown, number, string][] = [
      ["not json", "{nope", 400, "invalid_json"],
      ["empty body", "", 400, "invalid_json"],
      ["missing prompt", { role: "worker", cwd: r.work }, 400, "invalid_request"],
      ["empty prompt", { role: "worker", cwd: r.work, prompt: "" }, 400, "invalid_request"],
      ["prompt too long", { role: "worker", cwd: r.work, prompt: "x".repeat(10_001) }, 400, "invalid_request"],
      ["cwd not text", { role: "worker", cwd: 5, prompt: "x" }, 400, "invalid_request"],
      ["unknown field", { role: "worker", cwd: r.work, prompt: "x", extra: 1 }, 400, "invalid_request"],
      ["unknown role", { role: "admin", cwd: r.work, prompt: "x" }, 400, "invalid_request"],
      ["master not available yet", { role: "master", cwd: r.work, prompt: "x" }, 400, "unsupported_role"],
      ["array", [1, 2], 400, "invalid_request"],
      ["null", "null", 400, "invalid_request"],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await r.post("/api/agents", body);
      assert.equal(res.status, status, name);
      assert.deepEqual(JSON.parse(res.body), { error: code }, name);
    }
    assert.equal(r.calls.length, 0);
    assert.equal(r.registry.size(), 0);
  });

  it("requires a JSON content type", async () => {
    const r = await rig();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await r.post("/api/agents", JSON.stringify({ role: "worker", cwd: r.work, prompt: "x" }), { "content-type": type });
      assert.equal(res.status, 415, type);
    }
    const noType = await send(r.srv.port, "/api/agents", {
      method: "POST",
      body: "{}",
      headers: { host: r.auth.host, cookie: r.auth.cookie, origin: `http://${r.auth.host}` },
    });
    assert.equal(noType.status, 415);
    const withCharset = await r.post("/api/agents", { role: "worker", cwd: r.work, prompt: "x" }, { "content-type": "application/json; charset=utf-8" });
    assert.equal(withCharset.status, 201);
    assert.equal(r.calls.length, 1);
  });

  it("stops reading a body that is too large and keeps serving", async () => {
    const r = await rig();
    const big = JSON.stringify({ role: "worker", cwd: r.work, prompt: "x".repeat(70_000) });
    const res = await r.post("/api/agents", big);
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: "too_large" });
    assert.equal(res.headers["connection"], "close");
    assert.equal(r.calls.length, 0);
    assert.equal((await r.start()).status, 201, "the server still works");
  });

  it("limits a body sent in pieces with no declared length", async () => {
    const r = await rig();
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: r.srv.port, path: "/api/agents", method: "POST", headers: { ...r.headers(), "transfer-encoding": "chunked" } },
        (response) => {
          let body = "";
          response.on("data", (c: Buffer) => (body += c));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      const piece = "x".repeat(8 * 1024);
      req.write('{"role":"worker","cwd":"x","prompt":"');
      for (let i = 0; i < 12; i++) req.write(piece); // 96 KB, over the 64 KB limit
      req.end('"}');
    });
    assert.equal(res.status, 413);
    assert.equal(r.calls.length, 0);
  });

  it("refuses a folder outside the allowed roots (403) and one that does not exist (400)", async () => {
    const r = await rig();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    dirs.push(outside);
    const denied = await r.start({ cwd: outside });
    assert.equal(denied.status, 403);
    assert.deepEqual(JSON.parse(denied.body), { error: "folder_not_allowed" });
    const missing = await r.start({ cwd: join(r.root, "nope") });
    assert.equal(missing.status, 400);
    assert.deepEqual(JSON.parse(missing.body), { error: "invalid_folder" });
    assert.equal(r.calls.length, 0);
  });

  it("answers 429 once the limit is reached", async () => {
    const r = await rig({}, { maxManaged: 2 });
    assert.equal((await r.start()).status, 201);
    assert.equal((await r.start()).status, 201);
    const third = await r.start();
    assert.equal(third.status, 429);
    assert.deepEqual(JSON.parse(third.body), { error: "too_many" });
    assert.equal(r.calls.length, 2);
  });

  it("answers 502 when the session cannot be started on the subscription login", async () => {
    const r = await rig({ apiKeySource: "ANTHROPIC_API_KEY" });
    const res = await r.start();
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: "start_failed" });
  });

  it("does not echo the request back in any answer", async () => {
    const r = await rig();
    const secret = "TOP-SECRET-PROMPT";
    const bodies = [
      (await r.post("/api/agents", { role: "worker", cwd: r.work, prompt: secret, extra: 1 })).body,
      (await r.post("/api/agents", { role: "worker", cwd: join(r.root, secret), prompt: secret })).body,
    ];
    for (const body of bodies) assert.ok(!body.includes(secret));
  });
});

describe("stopping workers over HTTP", () => {
  it("stops a worker, tells the browser, and accepts a repeat", async () => {
    const r = await rig();
    const stream = await r.stream();
    const { id } = JSON.parse((await r.start()).body) as { id: string };
    const first = await r.post(`/api/agents/${id}/stop`);
    assert.equal(first.status, 202);
    const status = parse(await stream.next((e) => e.name === "agent.status" && e.data.includes('"stopped"'))) as { id: string };
    assert.equal(status.id, id);
    assert.equal(r.registry.get(id)?.status, "stopped");
    // Stopping a worker that has already ended dismisses it.
    assert.equal((await r.post(`/api/agents/${id}/stop`)).status, 202);
    assert.equal(r.registry.has(id), false);
    assert.equal((await r.post(`/api/agents/${id}/stop`)).status, 404);
  });

  it("stops a worker that ignores the polite stop", async () => {
    const r = await rig({ stubborn: true, spawnChild: true });
    const { id } = JSON.parse((await r.start()).body) as { id: string };
    const res = await r.post(`/api/agents/${id}/stop`);
    assert.equal(res.status, 202);
    assert.equal(r.registry.get(id)?.status, "stopped");
    assert.equal(r.sessions[0]?.aborted, true);
  });

  it("stops everything with stop-all", async () => {
    const r = await rig();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((JSON.parse((await r.start()).body) as { id: string }).id);
    assert.equal((await r.post("/api/agents/stop-all")).status, 202);
    for (const id of ids) assert.equal(r.registry.get(id)?.status, "stopped");
    assert.equal(r.supervisor.liveCount(), 0);
  });

  it("answers 404 for an unknown id and 409 for a session that is only watched", async () => {
    const r = await rig();
    assert.equal((await r.post("/api/agents/nope/stop")).status, 404);
    r.registry.upsert("observed-1", { kind: "session", parentId: null, project: "p", name: "p", currentTask: null });
    const res = await r.post("/api/agents/observed-1/stop");
    assert.equal(res.status, 409);
    assert.deepEqual(JSON.parse(res.body), { reason: "observed" });
    assert.equal(r.registry.get("observed-1")?.status, "idle", "a watched session is untouched");
  });

  it("dismisses a detached worker with stop (202)", async () => {
    const r = await rig();
    await r.restartWith("old-one");
    assert.equal((await r.post("/api/agents/old-one/stop")).status, 202);
    assert.equal(r.registry.has("old-one"), false);
    assert.equal((await r.post("/api/agents/old-one/stop")).status, 404);
  });
});

describe("tasks and resume over HTTP", () => {
  const reason = async (r: Awaited<ReturnType<typeof rig>>, path: string, body: object = { prompt: "x" }) => {
    const res = await r.post(path, body);
    return [res.status, JSON.parse(res.body) as unknown];
  };

  it("accepts a task for an idle worker (202) and answers busy (409) while it works", async () => {
    const r = await rig();
    const { id } = JSON.parse((await r.start()).body) as { id: string };
    assert.deepEqual(await reason(r, `/api/agents/${id}/tasks`), [409, { reason: "busy" }]);
    await r.endTurn(0);
    assert.deepEqual(await reason(r, `/api/agents/${id}/tasks`, { prompt: "second" }), [202, {}]);
    assert.deepEqual(await reason(r, `/api/agents/${id}/tasks`), [409, { reason: "busy" }]);
    assert.equal(r.sessions[0]?.prompts.length, 2);
  });

  it("answers 409 with a reason for stopped, detached and watched sessions, and 404 for an unknown one", async () => {
    const r = await rig();
    const { id } = JSON.parse((await r.start()).body) as { id: string };
    await r.post(`/api/agents/${id}/stop`);
    await r.restartWith("old-one");
    r.registry.upsert("seen", { kind: "session", parentId: null, project: "p", name: "p", currentTask: null });
    assert.deepEqual(await reason(r, `/api/agents/${id}/tasks`), [409, { reason: "stopped" }]);
    assert.deepEqual(await reason(r, "/api/agents/old-one/tasks"), [409, { reason: "detached" }]);
    assert.deepEqual(await reason(r, "/api/agents/seen/tasks"), [409, { reason: "observed" }]);
    assert.deepEqual(await reason(r, "/api/agents/seen/resume", {}), [409, { reason: "observed" }]);
    assert.deepEqual(await reason(r, "/api/agents/nope/tasks"), [404, { error: "not_found" }]);
    assert.deepEqual(await reason(r, "/api/agents/nope/resume", {}), [404, { error: "not_found" }]);
    assert.equal(r.calls.length, 1);
  });

  it("refuses bad task and resume bodies with a short code and starts nothing", async () => {
    const r = await rig({ sessionId: () => "old-one" });
    await r.restartWith("old-one");
    const cases: [string, string, unknown, number, string][] = [
      ["tasks", "not json", "{nope", 400, "invalid_json"],
      ["tasks", "missing prompt", {}, 400, "invalid_request"],
      ["tasks", "empty prompt", { prompt: "" }, 400, "invalid_request"],
      ["tasks", "long prompt", { prompt: "x".repeat(10_001) }, 400, "invalid_request"],
      ["tasks", "unknown field", { prompt: "x", extra: 1 }, 400, "invalid_request"],
      ["resume", "empty prompt", { prompt: "" }, 400, "invalid_request"],
      ["resume", "unknown field", { cwd: "C:\\" }, 400, "invalid_request"],
      ["resume", "null", "null", 400, "invalid_request"],
    ];
    for (const [route, name, body, status, code] of cases) {
      const res = await r.post(`/api/agents/old-one/${route}`, body);
      assert.equal(res.status, status, `${route} ${name}`);
      assert.deepEqual(JSON.parse(res.body), { error: code }, `${route} ${name}`);
    }
    assert.equal((await r.post("/api/agents/old-one/tasks", JSON.stringify({ prompt: "x".repeat(70_000) }))).status, 413);
    assert.equal((await r.post("/api/agents/old-one/resume", "{}", { "content-type": "text/plain" })).status, 415);
    assert.equal(r.calls.length, 0);
  });

  it("resumes a detached worker (202) with the default message or a given one, and tells the browser", async () => {
    const r = await rig({ sessionId: () => "old-one" });
    await r.restartWith("old-one");
    const stream = await r.stream();
    assert.deepEqual(await reason(r, "/api/agents/old-one/resume", {}), [202, {}]);
    await stream.next((e) => e.name === "agent.status" && e.data.includes('"working"'));
    assert.equal(r.calls[0]?.resume, "old-one");
    assert.equal(r.sessions[0]?.prompts[0]?.message.content, "Continue where you left off.");
    assert.deepEqual(await reason(r, "/api/agents/old-one/resume", {}), [409, { reason: "not_resumable" }], "it is running now");
    await r.post("/api/agents/old-one/stop");
    assert.deepEqual(await reason(r, "/api/agents/old-one/resume", { prompt: "Do part two" }), [202, {}]);
    assert.equal(r.sessions[1]?.prompts[0]?.message.content, "Do part two");
  });

  it("answers the resume refusals: 429 budget, 403 folder, 502 wrong id", async () => {
    const used = await rig({}, { sessionBudgetUsd: 1 });
    await saveStore(join(used.root, "data"), [storedWorker("spent", { cwd: used.work, costUsdTotal: 1 })]);
    await used.supervisor.recover();
    assert.deepEqual(await reason(used, "/api/agents/spent/resume", {}), [429, { error: "budget" }]);

    const away = await rig();
    await saveStore(join(away.root, "data"), [storedWorker("away", { cwd: tmpdir() })]);
    await away.supervisor.recover();
    assert.deepEqual(await reason(away, "/api/agents/away/resume", {}), [403, { error: "folder_not_allowed" }]);

    const wrong = await rig(); // reports another id than the one stored
    await wrong.restartWith("mine");
    assert.deepEqual(await reason(wrong, "/api/agents/mine/resume", {}), [502, { error: "start_failed" }]);
    assert.equal(used.calls.length + away.calls.length, 0);
  });

  it("answers 429 for a new task and a new start when the app budget is used up", async () => {
    const r = await rig({}, { totalBudgetUsd: 1 });
    const a = JSON.parse((await r.start()).body) as { id: string };
    const b = JSON.parse((await r.start()).body) as { id: string };
    await r.endTurn(0, 0.6);
    await r.endTurn(1, 0.6);
    assert.equal(r.registry.get(b.id)?.status === "stopped" || r.registry.get(a.id)?.status === "stopped", true);
    const alive = r.registry.get(a.id)?.status === "stopped" ? b.id : a.id;
    assert.deepEqual(await reason(r, `/api/agents/${alive}/tasks`), [429, { error: "budget" }]);
    assert.equal((await r.start()).status, 429);
  });

  it("shows the waiting state and its note to the browser", async () => {
    const r = await rig();
    const stream = await r.stream();
    const { id } = JSON.parse((await r.start()).body) as { id: string };
    r.sessions[0]?.out.push(rateLimitMessage("rejected"));
    const updated = await stream.next((e) => e.name === "agent.updated" && e.data.includes("Usage limit"));
    assert.equal((parse(updated) as { agent: { id: string } }).agent.id, id);
    assert.equal(r.registry.get(id)?.status, "waiting");
  });
});

describe("the guard in front of the new routes", () => {
  it("refuses requests without the session cookie, from a foreign Origin, or for a foreign Host", async () => {
    const r = await rig();
    const body = JSON.stringify({ role: "worker", cwd: r.work, prompt: "x" });
    const noCookie = await send(r.srv.port, "/api/agents", { method: "POST", body, headers: { host: r.auth.host, origin: `http://${r.auth.host}`, "content-type": "application/json" } });
    assert.equal(noCookie.status, 403);
    const badOrigin = await r.post("/api/agents", body, { origin: "http://evil.example" });
    assert.equal(badOrigin.status, 403);
    const noOrigin = await send(r.srv.port, "/api/agents", { method: "POST", body, headers: { host: r.auth.host, cookie: r.auth.cookie, "content-type": "application/json" } });
    assert.equal(noOrigin.status, 403);
    const badHost = await r.post("/api/agents", body, { host: `evil.example:${r.srv.port}` });
    assert.equal(badHost.status, 403);
    for (const path of ["/api/agents/stop-all", "/api/agents/x/stop", "/api/agents/x/tasks", "/api/agents/x/resume"]) {
      const res = await send(r.srv.port, path, { method: "POST", body: "{}", headers: { host: r.auth.host, origin: "http://evil.example", cookie: r.auth.cookie, "content-type": "application/json" } });
      assert.equal(res.status, 403, path);
    }
    assert.equal(r.calls.length, 0);
  });

  it("does not answer GET on the control routes", async () => {
    const r = await rig();
    for (const path of ["/api/agents", "/api/agents/stop-all", "/api/agents/x/stop", "/api/agents/x/tasks", "/api/agents/x/resume"]) {
      const res = await send(r.srv.port, path, { headers: { host: r.auth.host, cookie: r.auth.cookie } });
      assert.equal(res.status, 404, path);
    }
  });

  it("has no start route when the server runs without a supervisor", async () => {
    const root = mkdtempSync(join(tmpdir(), "no-sup-"));
    dirs.push(root);
    const srv = await startServer({ port: 0, staticDir: root, registry: createRegistry(), log: () => {} });
    servers.push(srv);
    const auth = await loginTo(srv);
    const res = await send(srv.port, "/api/agents", {
      method: "POST",
      body: "{}",
      headers: { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" },
    });
    assert.equal(res.status, 404);
  });
});
