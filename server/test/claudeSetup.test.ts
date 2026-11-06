import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { listMcpServers, listSkills, skillDescription } from "../src/claudeSetup.ts";
import { loginTo, send } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "setup-")));
  dirs.push(d);
  return d;
};

function fixture() {
  const root = tmp();
  const skills = join(root, "skills");
  mkdirSync(join(skills, "clean-code"), { recursive: true });
  mkdirSync(join(skills, "no-file"));
  mkdirSync(join(skills, "bad[name]"));
  writeFileSync(join(skills, "clean-code", "SKILL.md"), "---\nname: clean-code\ndescription: Pragmatic standards\u202e hidden\nallowed-tools: Read\n---\nbody SECRET-BODY\n");
  writeFileSync(join(skills, "a-file.md"), "x");
  const mcpFile = join(root, "claude.json");
  writeFileSync(
    mcpFile,
    JSON.stringify({
      oauth: "SECRET-OAUTH",
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["server.js", "--token=SECRET-ARG"], env: { KEY: "SECRET-ENV", B: "x" } },
        remote: { type: "http", url: "https://mcp.example.com/path/SECRET-PATH?key=SECRET-QUERY", headers: { Authorization: "Bearer SECRET-HEADER" } },
        "bad name\n": { command: "x" },
        wholeline: { type: "stdio", command: "npx -y foo --token=SECRET-CMD", args: [] },
      },
    }),
  );
  return { root, skills, mcpFile };
}

describe("claude setup: skills and MCP servers for the sidebar", () => {
  it("reads descriptions leniently and strips unsafe characters", () => {
    assert.equal(skillDescription("---\nname: x\ndescription: One line\n---\n"), "One line");
    assert.equal(skillDescription('---\ndescription: "Quoted text"\n---\n'), "Quoted text");
    assert.equal(skillDescription("no frontmatter\ndescription: nope"), "");
    assert.equal(skillDescription(`---\ndescription: ${"x".repeat(500)}\n---\n`).length, 200);
  });

  it("lists skill folders with descriptions and leaves out files and odd names", async () => {
    const { skills } = fixture();
    const list = await listSkills(skills);
    assert.deepEqual(list.map((s) => s.name), ["clean-code", "no-file"]);
    assert.equal(list[0]?.description, "Pragmatic standards hidden");
    assert.equal(list[1]?.description, "");
    assert.deepEqual([(list[0]?.modified ?? 0) > 0, list[1]?.modified], [true, 0], "SKILL.md time, or 0 without one");
    assert.deepEqual(await listSkills(join(skills, "missing")), []);
    assert.deepEqual(await listSkills(undefined), []);
  });

  it("lists servers by shape only: no env values, headers, arguments, URL paths or queries", async () => {
    const { mcpFile } = fixture();
    const list = await listMcpServers(mcpFile);
    assert.deepEqual(list, [
      { name: "local", type: "stdio", command: "node", argCount: 2, envCount: 2, hasHeaders: false },
      { name: "remote", type: "http", host: "mcp.example.com", envCount: 0, hasHeaders: true },
      { name: "wholeline", type: "stdio", command: "npx", argCount: 0, envCount: 0, hasHeaders: false },
    ]);
    assert.doesNotMatch(JSON.stringify(list), /SECRET/);
    assert.deepEqual(await listMcpServers(join(tmp(), "none.json")), []);
  });

  it("answers GET /api/setup for a signed-in page only", async () => {
    const { skills, mcpFile, root } = fixture();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir: skills, mcpFile } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const got = await send(srv.port, "/api/setup", { headers: { host: auth.host, cookie: auth.cookie } });
    assert.equal(got.status, 200);
    const body = JSON.parse(got.body) as { skills: unknown[]; mcp: unknown[] };
    assert.deepEqual([body.skills.length, body.mcp.length], [2, 3]);
    assert.doesNotMatch(got.body, /SECRET/);
    assert.equal((await send(srv.port, "/api/setup", { headers: { host: auth.host } })).status, 403);
  });
});
