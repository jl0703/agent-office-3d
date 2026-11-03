import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { createRegistry } from "../src/registry.ts";
import { startWatcher, type Watcher } from "../src/watcher.ts";
import { loginTo, openStream, parse, send, type Stream } from "./helpers.ts";

const SESSION = "33333333-aaaa-bbbb-cccc-444444444444";
const stamp = () => new Date().toISOString();
const userLine = (prompt = "hello") =>
  JSON.stringify({ type: "user", timestamp: stamp(), cwd: "C:\\work\\demo", message: { content: prompt } }) + "\n";
const toolLine = (id: string, input: object) =>
  JSON.stringify({ type: "assistant", timestamp: stamp(), cwd: "C:\\work\\demo", message: { content: [{ type: "tool_use", id, name: "Edit", input }] } }) + "\n";

describe("observing sessions over HTTP", () => {
  let root: string;
  let project: string;
  let srv: RunningServer;
  let watcher: Watcher;
  let auth: { host: string; cookie: string };
  const streams: Stream[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "observe-"));
    project = join(root, "logs", "c--work-demo");
    mkdirSync(project, { recursive: true });
    const registry = createRegistry();
    // The backup sweep is an hour away, so only file watching can meet the 2 second goal.
    watcher = await startWatcher({ root: join(root, "logs"), registry, sweepMs: 3_600_000, log: () => {} });
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<p>x</p>");
    srv = await startServer({ port: 0, staticDir, registry, heartbeatMs: 60_000, log: () => {} });
    auth = await loginTo(srv);
  });
  after(async () => {
    for (const s of streams) s.close();
    await watcher.close();
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  });

  const open = async () => {
    const s = await openStream(srv.port, auth);
    streams.push(s);
    return s;
  };

  it("sends a snapshot first, then a new session and its tool calls within 2 seconds (QR-1)", async () => {
    const stream = await open();
    const first = await stream.next(() => true);
    assert.equal(first.name, "snapshot");
    assert.deepEqual((parse(first) as { agents: unknown[] }).agents, []);

    const file = join(project, `${SESSION}.jsonl`);
    const t0 = Date.now();
    writeFileSync(file, userLine());
    const spawned = await stream.next((e) => e.name === "agent.spawned", 2000);
    assert.ok(Date.now() - t0 < 2000);
    const agent = (parse(spawned) as { agent: { id: string; project: string; origin: string } }).agent;
    assert.equal(agent.id, SESSION);
    assert.equal(agent.project, "demo");
    assert.equal(agent.origin, "observed");

    const t1 = Date.now();
    appendFileSync(file, toolLine("t1", { file_path: "C:\\work\\demo\\src\\app.ts", new_string: "SECRET_CODE" }));
    const activity = await stream.next((e) => e.name === "agent.activity", 2000);
    assert.ok(Date.now() - t1 < 2000);
    assert.equal((parse(activity) as { summary: string }).summary, "Edit app.ts");
    assert.ok(!stream.events.some((e) => e.data.includes("SECRET_CODE")), "tool input never reaches the browser");
  });

  it("gives a later connection the current state in its snapshot", async () => {
    const stream = await open();
    const first = parse(await stream.next((e) => e.name === "snapshot")) as { agents: { id: string; activity: string }[] };
    assert.equal(first.agents.length, 1);
    assert.equal(first.agents[0]?.id, SESSION);
    assert.equal(first.agents[0]?.activity, "Edit app.ts");
  });

  it("rejects commands for an observed session with 409 and an unknown one with 404", async () => {
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}` };
    for (const action of ["tasks", "stop", "resume"]) {
      const observed = await send(srv.port, `/api/agents/${SESSION}/${action}`, { method: "POST", headers });
      assert.equal(observed.status, 409, action);
      assert.deepEqual(JSON.parse(observed.body), { reason: "observed" });
      const unknown = await send(srv.port, `/api/agents/nope/${action}`, { method: "POST", headers });
      assert.equal(unknown.status, 404, action);
    }
  });

  it("keeps the guard in front of the command routes", async () => {
    const path = `/api/agents/${SESSION}/stop`;
    const noCookie = await send(srv.port, path, { method: "POST", headers: { host: auth.host, origin: `http://${auth.host}` } });
    assert.equal(noCookie.status, 403);
    const badOrigin = await send(srv.port, path, { method: "POST", headers: { host: auth.host, cookie: auth.cookie, origin: "http://evil.example" } });
    assert.equal(badOrigin.status, 403);
    const get = await send(srv.port, path, { headers: { host: auth.host, cookie: auth.cookie } });
    assert.equal(get.status, 404);
  });
});
