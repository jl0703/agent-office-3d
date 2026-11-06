import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { findClaude, type ClaudeRunner } from "../src/claudeCli.ts";
import { addedServers, addServer, buildArgs, previewLine, removeServer, type McpInput } from "../src/mcpManage.ts";
import { loginTo, send } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-")));
  dirs.push(d);
  return d;
};

const local: McpInput = { name: "my-server", transport: "stdio", command: "npx", args: ["-y", "my-mcp"], env: { API_KEY: "SECRET-ENV" } };
const remote: McpInput = { name: "docs", transport: "http", url: "https://mcp.example.com/mcp", headers: ["Authorization: Bearer SECRET-HEADER"] };

describe("mcp: building the command", () => {
  it("builds each value as its own word, with -e and -H before the program, and refuses anything odd", () => {
    assert.deepEqual(buildArgs(local), ["mcp", "add", "--scope", "user", "--transport", "stdio", "my-server", "-e", "API_KEY=SECRET-ENV", "--", "npx", "-y", "my-mcp"]);
    assert.deepEqual(buildArgs(remote), ["mcp", "add", "--scope", "user", "--transport", "http", "docs", "https://mcp.example.com/mcp", "-H", "Authorization: Bearer SECRET-HEADER"]);
    assert.ok(buildArgs({ name: "dev", transport: "sse", url: "http://localhost:3000/sse" }));
    const bad: McpInput[] = [
      { ...local, name: "bad name" },
      { ...local, name: "-x" },
      { ...local, command: "--evil" },
      { ...local, command: "a\nb" },
      { ...local, args: Array.from({ length: 21 }, () => "x") },
      { ...local, env: { "bad-key": "x" } },
      { ...local, env: { OK: "line\nbreak" } },
      { ...local, url: "https://x.example" },
      { ...remote, command: "npx" },
      { ...remote, url: "http://example.com/mcp" },
      { ...remote, url: "https://user:pass@example.com/mcp" },
      { ...remote, url: "--flag" },
      { ...remote, headers: ["no colon"] },
      { ...remote, headers: Array.from({ length: 6 }, () => "A: b") },
    ];
    for (const input of bad) assert.equal(buildArgs(input), null, JSON.stringify(input));
  });

  it("previews the exact command with environment and header values hidden", () => {
    const text = previewLine(buildArgs(local) ?? []);
    assert.equal(text, "claude mcp add --scope user --transport stdio my-server -e API_KEY=(hidden) -- npx -y my-mcp");
    assert.doesNotMatch(previewLine(buildArgs(remote) ?? []), /SECRET/);
    assert.match(previewLine(buildArgs(remote) ?? []), /-H "Authorization: \(hidden\)"/);
  });
});

describe("mcp: finding the claude program", () => {
  it("uses the override, claude.exe, the exe behind a claude.cmd shim on Windows, or claude on PATH elsewhere", () => {
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    assert.equal(findClaude({ OFFICE_CLAUDE_BIN: "/x/claude" }, "linux", has("/x/claude")), "/x/claude");
    assert.equal(findClaude({ OFFICE_CLAUDE_BIN: "/nope" }, "linux", has()), null);
    assert.equal(findClaude({ PATH: ["/a", "/b"].join(delimiter) }, "linux", has(join("/b", "claude"))), join("/b", "claude"));
    assert.equal(findClaude({ PATH: "/a" }, "linux", has()), null);
    const dir = join("C:", "npm");
    const shim = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    assert.equal(findClaude({ PATH: dir }, "win32", has(join(dir, "claude.cmd"), shim)), shim);
    assert.equal(findClaude({ PATH: dir }, "win32", has(join(dir, "claude.cmd"))), null, "a .cmd alone cannot be started without a shell");
    assert.equal(findClaude({ PATH: dir }, "win32", has(join(dir, "claude.exe"))), join(dir, "claude.exe"));
  });
});

function deps() {
  const root = tmp();
  const calls: string[][] = [];
  const state = { names: [] as string[], ok: true };
  const run: ClaudeRunner = async (args) => {
    calls.push(args);
    return { ok: state.ok };
  };
  return { calls, state, addedFile: join(root, "data", "mcp-added.json"), run, existing: async () => state.names };
}

describe("mcp: adding and removing", () => {
  it("runs the command, remembers the server, refuses a name already in use, and does not remember a failure", async () => {
    const d = deps();
    assert.deepEqual(await addServer(d, local), { ok: true });
    assert.deepEqual(d.calls[0], buildArgs(local));
    assert.deepEqual([...(await addedServers(d.addedFile))], ["my-server"]);
    d.state.names = ["taken"];
    assert.deepEqual(await addServer(d, { ...local, name: "taken" }), { ok: false, code: "exists" });
    assert.equal(d.calls.length, 1, "nothing was run for a taken name");
    d.state.ok = false;
    assert.deepEqual(await addServer(d, { ...local, name: "other" }), { ok: false, code: "failed" });
    assert.deepEqual([...(await addedServers(d.addedFile))], ["my-server"]);
    assert.deepEqual(await addServer(d, { ...local, command: "--x" }), { ok: false, code: "invalid_input" });
  });

  it("removes only servers added here", async () => {
    const d = deps();
    await addServer(d, local);
    assert.deepEqual(await removeServer(d, "someone-elses"), { ok: false, code: "not_added" });
    assert.deepEqual(await removeServer(d, "../x"), { ok: false, code: "invalid_input" });
    assert.deepEqual(await removeServer(d, "my-server"), { ok: true });
    assert.deepEqual(d.calls.at(-1), ["mcp", "remove", "--scope", "user", "my-server"]);
    assert.deepEqual([...(await addedServers(d.addedFile))], []);
    d.state.ok = false;
    await addServer({ ...d, run: async () => ({ ok: true }) }, local);
    assert.deepEqual(await removeServer(d, "my-server"), { ok: false, code: "failed" });
    assert.deepEqual([...(await addedServers(d.addedFile))], ["my-server"], "still listed when the command failed");
  });
});

describe("mcp: the routes", () => {
  it("preview, add and remove need confirm and a signed-in page, run the exact command, and never return its output", async () => {
    const root = tmp();
    const mcpFile = join(root, "claude.json");
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { existing: { command: "x" } } }));
    const calls: string[][] = [];
    // Stands in for the real program: it edits the settings file the way `claude mcp add|remove` would.
    const runClaude: ClaudeRunner = async (args) => {
      calls.push(args);
      const file = JSON.parse(readFileSync(mcpFile, "utf8")) as { mcpServers: Record<string, unknown> };
      if (args[1] === "add") file.mcpServers[args[6] ?? ""] = { command: "npx" };
      else delete file.mcpServers[args[4] ?? ""];
      writeFileSync(mcpFile, JSON.stringify(file));
      return { ok: true };
    };
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir: join(root, "skills"), mcpFile, dataDir: join(root, "data"), runClaude } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
    const post = (path: string, body: unknown, more: Record<string, string> = {}) => send(srv.port, path, { method: "POST", headers: { ...headers, ...more }, body: JSON.stringify(body) });
    const list = async () => JSON.parse((await send(srv.port, "/api/setup", { headers: { host: auth.host, cookie: auth.cookie } })).body) as { mcp: { name: string; added: boolean }[]; canManageMcp: boolean };

    const preview = await post("/api/setup/mcp/preview", local);
    assert.equal(preview.status, 200);
    assert.equal((JSON.parse(preview.body) as { command: string }).command, "claude mcp add --scope user --transport stdio my-server -e API_KEY=(hidden) -- npx -y my-mcp");
    assert.equal(calls.length, 0, "a preview runs nothing");
    assert.equal((await post("/api/setup/mcp/preview", { ...local, command: "--evil" })).status, 400);
    assert.equal((await post("/api/setup/mcp", local)).status, 400, "no confirm");
    assert.equal((await post("/api/setup/mcp", { ...local, confirm: false })).status, 400);
    assert.equal((await post("/api/setup/mcp", { ...local, extra: 1, confirm: true })).status, 400, "unknown field");
    assert.equal((await post("/api/setup/mcp", { ...local, confirm: true }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await send(srv.port, "/api/setup/mcp", { method: "POST", headers: { host: auth.host, "content-type": "application/json", origin: `http://${auth.host}` }, body: "{}" })).status, 403);
    assert.equal(calls.length, 0);

    const added = await post("/api/setup/mcp", { ...local, confirm: true });
    assert.deepEqual([added.status, added.body], [201, "{}"]);
    assert.deepEqual(calls[0], buildArgs(local));
    const dup = await post("/api/setup/mcp", { ...local, confirm: true });
    assert.deepEqual([dup.status, JSON.parse(dup.body)], [409, { reason: "exists" }]);
    const shown = await list();
    assert.equal(shown.canManageMcp, true);
    assert.deepEqual(shown.mcp.map((s) => [s.name, s.added]), [["existing", false], ["my-server", true]]);

    const refused = await post("/api/setup/mcp/remove", { name: "existing", confirm: true });
    assert.deepEqual([refused.status, JSON.parse(refused.body)], [409, { reason: "not_added" }]);
    assert.equal((await post("/api/setup/mcp/remove", { name: "my-server" })).status, 400);
    assert.equal((await post("/api/setup/mcp/remove", { name: "my-server", confirm: true })).status, 200);
    assert.deepEqual((await list()).mcp.map((s) => s.name), ["existing"]);
    assert.equal(existsSync(join(root, "data", "mcp-added.json")), true);
  });

  it("answers 404 for the MCP routes when there is no claude program", async () => {
    const root = tmp();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir: join(root, "s"), mcpFile: join(root, "c.json"), dataDir: join(root, "data") } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const r = await send(srv.port, "/api/setup/mcp/preview", { method: "POST", headers: { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" }, body: JSON.stringify(local) });
    assert.equal(r.status, 404);
    const l = JSON.parse((await send(srv.port, "/api/setup", { headers: { host: auth.host, cookie: auth.cookie } })).body) as { canManageMcp: boolean };
    assert.equal(l.canManageMcp, false);
  });
});
