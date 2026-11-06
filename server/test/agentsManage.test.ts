import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { addAgent, addedAgents, agentDirsFor, agentFacts, removeAgent } from "../src/agentsManage.ts";
import { listAgents } from "../src/claudeSetup.ts";
import { MAX_SKILL_BYTES } from "../src/skillsManage.ts";
import { loginTo, send } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "agents-")));
  dirs.push(d);
  return d;
};
const agent = (name: string, extra = "model: sonnet\ntools: Read, Grep\n") => `---\nname: ${name}\ndescription: Reviews code carefully\n${extra}---\nYou review code.\n`;

function rig() {
  const root = tmp();
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "old-agent.md"), agent("old-agent"));
  return { root, agentsDir, d: agentDirsFor(agentsDir, join(root, "data")) };
}

describe("agents: listing", () => {
  it("lists agent files with description, model and tools, and skips folders and odd names", async () => {
    const { agentsDir } = rig();
    mkdirSync(join(agentsDir, "a-folder.md"));
    writeFileSync(join(agentsDir, "bad[name].md"), agent("x"));
    writeFileSync(join(agentsDir, "notes.txt"), "x");
    const list = await listAgents(agentsDir);
    assert.deepEqual(list.map((a) => [a.name, a.description, a.model, a.tools]), [["old-agent", "Reviews code carefully", "sonnet", "Read, Grep"]]);
    assert.ok((list[0]?.modified ?? 0) > 0);
    assert.deepEqual(await listAgents(join(agentsDir, "missing")), []);
    assert.deepEqual(agentFacts("no header"), { description: "", model: "", tools: "" });
  });
});

describe("agents: adding and removing", () => {
  it("creates an agent from pasted text or a file, never replaces one, and refuses bad input", async () => {
    const { root, agentsDir, d } = rig();
    assert.deepEqual(await addAgent(d, { name: "new-agent", content: agent("new-agent") }), { ok: true });
    assert.equal(readFileSync(join(agentsDir, "new-agent.md"), "utf8"), agent("new-agent"));
    assert.deepEqual([...(await addedAgents(d))], ["new-agent"]);
    assert.deepEqual(await addAgent(d, { name: "old-agent", content: agent("old-agent", "model: opus\n") }), { ok: false, code: "exists" });
    assert.equal(readFileSync(join(agentsDir, "old-agent.md"), "utf8"), agent("old-agent"), "the existing file is untouched");
    const file = join(root, "from.md");
    writeFileSync(file, agent("from-file"));
    assert.deepEqual(await addAgent(d, { name: "from-file", source: file }), { ok: true });
    assert.deepEqual(await addAgent(d, { name: "x", source: join(root, "nope.md") }), { ok: false, code: "source_missing" });
    assert.deepEqual(await addAgent(d, { name: "x", source: root }), { ok: false, code: "source_missing" }, "a folder is not an agent file");
    assert.deepEqual(await addAgent(d, { name: "net", source: "//host/share/a.md" }), { ok: false, code: "source_missing" });
    assert.deepEqual(await addAgent(d, { name: "../x", content: agent("x") }), { ok: false, code: "invalid_name" });
    assert.deepEqual(await addAgent(d, { name: "con", content: agent("con") }), { ok: false, code: "invalid_name" });
    assert.deepEqual(await addAgent(d, { name: "mismatch", content: agent("other") }), { ok: false, code: "invalid_skill" });
    assert.deepEqual(await addAgent(d, { name: "huge", content: agent("huge") + "x".repeat(MAX_SKILL_BYTES) }), { ok: false, code: "too_big" });
    assert.deepEqual(await addAgent(d, { name: "empty" }), { ok: false, code: "invalid_skill" });
    assert.deepEqual(readdirSync(agentsDir).sort(), ["from-file.md", "new-agent.md", "old-agent.md"]);
  });

  it("moves only an agent added here to the trash, and refuses a link", async () => {
    const { root, agentsDir, d } = rig();
    await addAgent(d, { name: "mine", content: agent("mine") });
    assert.deepEqual(await removeAgent(d, "old-agent"), { ok: false, code: "not_added" });
    assert.deepEqual(await removeAgent(d, "../x"), { ok: false, code: "invalid_name" });
    assert.deepEqual(await removeAgent(d, "mine", () => 7), { ok: true });
    assert.equal(existsSync(join(agentsDir, "mine.md")), false);
    assert.equal(readFileSync(join(d.trashDir, "mine-7.md"), "utf8"), agent("mine"), "moved, not deleted");
    assert.deepEqual(await removeAgent(d, "mine"), { ok: false, code: "not_added" });
    // An added agent whose file was swapped for a link is refused and the link target stays.
    await addAgent(d, { name: "swapped", content: agent("swapped") });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.md"), "keep");
    rmSync(join(agentsDir, "swapped.md"));
    symlinkSync(elsewhere, join(agentsDir, "swapped.md"), "junction");
    assert.deepEqual(await removeAgent(d, "swapped"), { ok: false, code: "not_found" });
    assert.equal(readFileSync(join(elsewhere, "keep.md"), "utf8"), "keep");
  });
});

describe("agents: the routes", () => {
  it("add and remove need confirm and a signed-in page, and the list shows which agents were added here", async () => {
    const { root, agentsDir } = rig();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir: join(root, "s"), agentsDir, mcpFile: join(root, "c.json"), dataDir: join(root, "data") } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
    const post = (path: string, body: unknown, more: Record<string, string> = {}) => send(srv.port, path, { method: "POST", headers: { ...headers, ...more }, body: JSON.stringify(body) });
    const list = async () => JSON.parse((await send(srv.port, "/api/setup", { headers: { host: auth.host, cookie: auth.cookie } })).body) as { agents: { name: string; added: boolean }[]; canManageAgents: boolean };

    assert.equal((await post("/api/setup/agents", { name: "web-agent", content: agent("web-agent") })).status, 400, "no confirm");
    assert.equal((await post("/api/setup/agents", { name: "web-agent", content: agent("web-agent"), confirm: true }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await post("/api/setup/agents", { name: "web-agent", content: agent("web-agent"), confirm: true })).status, 201);
    const again = await post("/api/setup/agents", { name: "web-agent", content: agent("web-agent"), confirm: true });
    assert.deepEqual([again.status, JSON.parse(again.body)], [409, { reason: "exists" }]);
    const shown = await list();
    assert.equal(shown.canManageAgents, true);
    assert.deepEqual(shown.agents.map((a) => [a.name, a.added]), [["old-agent", false], ["web-agent", true]]);
    const refused = await post("/api/setup/agents/remove", { name: "old-agent", confirm: true });
    assert.deepEqual([refused.status, JSON.parse(refused.body)], [409, { reason: "not_added" }]);
    assert.equal((await post("/api/setup/agents/remove", { name: "web-agent" })).status, 400);
    assert.equal((await post("/api/setup/agents/remove", { name: "web-agent", confirm: true })).status, 200);
    assert.deepEqual((await list()).agents.map((a) => a.name), ["old-agent"]);
  });

  it("answers 404 for add and remove when there is no agents folder", async () => {
    const { root } = rig();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir: join(root, "s"), mcpFile: join(root, "c.json"), dataDir: join(root, "data") } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const r = await send(srv.port, "/api/setup/agents", { method: "POST", headers: { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" }, body: JSON.stringify({ name: "x", content: agent("x"), confirm: true }) });
    assert.equal(r.status, 404);
  });
});

describe("agents: header fields that add power", () => {
  it("refuses an agent file with hooks, a permission mode or its own MCP servers, however the key is written", async () => {
    const { d } = rig();
    for (const extra of ["hooks:\n  PreToolUse: x\n", "permissionMode: bypassPermissions\n", "PermissionMode: acceptEdits\n", "mcpServers:\n  x: y\n", "HOOKS: x\n", '"hooks": x\n', "'permissionMode': x\n", "? hooks\n", "{hooks: 1}\n", "unknown-field: x\n"]) {
      assert.deepEqual(await addAgent(d, { name: "risky", content: agent("risky", extra) }), { ok: false, code: "risky_header" }, extra);
    }
    assert.deepEqual(await addAgent(d, { name: "fine", content: agent("fine", "tools: Read, Grep\nmodel: haiku\ncolor: blue\n") }), { ok: true });
    assert.deepEqual(await addAgent(d, { name: "folded", content: agent("folded", "tools:\n  - Read\n  - Grep\n# a comment\n") }), { ok: true }, "list items and comments continue an allowed key");
    assert.equal(existsSync(join(d.agentsDir, "risky.md")), false);
  });

  it("copies only a .md file, and removes the file again when the list of added agents cannot be saved", async () => {
    const { root, d } = rig();
    const text = join(root, "agent.txt");
    writeFileSync(text, agent("from-text"));
    assert.deepEqual(await addAgent(d, { name: "from-text", source: text }), { ok: false, code: "source_missing" });
    mkdirSync(d.addedFile, { recursive: true }); // a folder where the list file should be: the write fails
    assert.deepEqual(await addAgent(d, { name: "unsaved", content: agent("unsaved") }), { ok: false, code: "failed" });
    assert.equal(existsSync(join(d.agentsDir, "unsaved.md")), false, "the new file is removed again");
  });
});
