import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { buildChildEnv } from "../src/childEnv.ts";
import { killTree } from "../src/killTree.ts";
import { DENIED_TOOLS, lockdownOptions, WORKER_TOOLS } from "../src/lockdown.ts";
import { parseRoots, resolveAllowedFolder } from "../src/paths.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

describe("child environment", () => {
  it("removes anything that could move a session off the subscription login", () => {
    const env = buildChildEnv({
      PATH: "p",
      HOME: "h",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });
    assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "ENABLE_CLAUDEAI_MCP_SERVERS", "HOME", "PATH"]);
  });

  it("matches names without regard to case, as Windows does", () => {
    const env = buildChildEnv({ Anthropic_Api_Key: "k", anthropic_auth_token: "t", Path: "p", enable_claudeai_mcp_servers: "true" });
    assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "ENABLE_CLAUDEAI_MCP_SERVERS", "Path"]);
    assert.equal(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "false");
  });

  it("turns off auto memory and claude.ai connectors, and drops empty values", () => {
    const env = buildChildEnv({ KEEP: "1", GONE: undefined });
    assert.equal(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
    assert.equal(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "false");
    assert.ok(!("GONE" in env));
  });

  it("does not change the environment it was given", () => {
    const source = { ANTHROPIC_API_KEY: "k", PATH: "p" };
    buildChildEnv(source);
    assert.deepEqual(source, { ANTHROPIC_API_KEY: "k", PATH: "p" });
  });
});

describe("lockdown options", () => {
  const o = lockdownOptions();

  it("denies anything not pre-approved and ignores outside settings", () => {
    assert.equal(o.permissionMode, "dontAsk");
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
  });

  it("offers and approves exactly the worker tools, including web search but not shell or page fetching", () => {
    assert.deepEqual(o.tools, ["Read", "Glob", "Grep", "Edit", "Write", "WebSearch"]);
    assert.deepEqual(o.allowedTools, o.tools);
    for (const banned of ["Bash", "PowerShell", "WebFetch", "Agent"]) {
      assert.ok(!WORKER_TOOLS.includes(banned), banned);
      assert.ok(DENIED_TOOLS.includes(banned), banned);
      assert.ok(o.disallowedTools?.includes(banned), banned);
    }
  });

  it("limits turns and spend", () => {
    assert.equal(o.maxTurns, 30);
    assert.equal(o.maxBudgetUsd, 2);
  });

  it("gives a fresh list each time, so no caller can loosen the shared one", () => {
    lockdownOptions().allowedTools?.push("Bash");
    assert.ok(!lockdownOptions().allowedTools?.includes("Bash"));
  });
});

describe("allowed folders", () => {
  it("accepts the root itself and folders inside it", async () => {
    const root = tmp("root-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    assert.deepEqual(await resolveAllowedFolder(root, [root]), { ok: true, path: (await resolveAllowedFolder(root, [root]) as { path: string }).path });
    const inner = await resolveAllowedFolder(join(root, "a", "b"), [root]);
    assert.ok(inner.ok);
  });

  it("refuses a folder outside every root, including a sibling with a similar name", async () => {
    const base = tmp("base-");
    mkdirSync(join(base, "work"));
    mkdirSync(join(base, "work-evil"));
    assert.deepEqual(await resolveAllowedFolder(join(base, "work-evil"), [join(base, "work")]), { ok: false, reason: "outside_roots" });
    assert.deepEqual(await resolveAllowedFolder(base, [join(base, "work")]), { ok: false, reason: "outside_roots" });
  });

  it("refuses to climb out with ..", async () => {
    const base = tmp("base-");
    mkdirSync(join(base, "work", "inner"), { recursive: true });
    const sneaky = join(base, "work", "inner", "..", "..");
    assert.deepEqual(await resolveAllowedFolder(sneaky, [join(base, "work")]), { ok: false, reason: "outside_roots" });
  });

  it("refuses a link that leads outside the root", async () => {
    const base = tmp("base-");
    mkdirSync(join(base, "work"));
    mkdirSync(join(base, "secret"));
    symlinkSync(join(base, "secret"), join(base, "work", "link"), "junction");
    assert.deepEqual(await resolveAllowedFolder(join(base, "work", "link"), [join(base, "work")]), { ok: false, reason: "outside_roots" });
  });

  it("refuses relative paths, missing folders, files, and a missing root", async () => {
    const root = tmp("root-");
    writeFileSync(join(root, "file.txt"), "x");
    assert.deepEqual(await resolveAllowedFolder("relative/path", [root]), { ok: false, reason: "not_absolute" });
    assert.deepEqual(await resolveAllowedFolder(join(root, "nope"), [root]), { ok: false, reason: "not_found" });
    assert.deepEqual(await resolveAllowedFolder(join(root, "file.txt"), [root]), { ok: false, reason: "not_directory" });
    assert.deepEqual(await resolveAllowedFolder(root, [join(root, "does-not-exist")]), { ok: false, reason: "outside_roots" });
    assert.deepEqual(await resolveAllowedFolder(root + "\0x", [root]), { ok: false, reason: "not_absolute" });
  });

  it("reads several roots from a setting and falls back to one folder when it is empty", () => {
    assert.deepEqual(parseRoots(`a${delimiter} b ${delimiter}${delimiter}c`, "fallback"), ["a", "b", "c"]);
    assert.deepEqual(parseRoots("", "fallback"), ["fallback"]);
    assert.deepEqual(parseRoots(undefined, "fallback"), ["fallback"]);
    assert.deepEqual(parseRoots(`  ${delimiter} `, "fallback"), ["fallback"]);
  });
});

describe("killing a process tree", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("ends a process and the process it started", async () => {
    // The parent starts a child that sleeps and prints the child's id.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
         console.log(c.pid); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true },
    );
    const childPid = await new Promise<number>((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
    const parentPid = parent.pid ?? 0;
    assert.ok(alive(parentPid) && alive(childPid));

    await killTree(parentPid);
    const end = Date.now() + 5000;
    while ((alive(parentPid) || alive(childPid)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(parentPid), false, "parent is gone");
    assert.equal(alive(childPid), false, "child is gone");
  });

  it("ignores ids that cannot be processes", async () => {
    await killTree(0);
    await killTree(-5);
    await killTree(1.5);
  });
});
