import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, describe, it } from "node:test";
import { checkToolCall, folderGuardHooks } from "../src/folderGuard.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
  made.push(base);
  const root = join(base, "work");
  const outside = join(base, "elsewhere");
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(outside, "secret.txt"), "secret");
  return { base, root, outside };
}

const ok = async (root: string, tool: string, input: unknown) => (await checkToolCall(root, tool, input)).ok;

describe("folder guard: file tools", () => {
  it("allows files and new files inside the folder", async () => {
    const { root } = layout();
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.equal(await ok(root, tool, { file_path: join(root, "a.txt") }), true, tool);
      assert.equal(await ok(root, tool, { file_path: join(root, "sub", "deep", "new.txt") }), true, `${tool} new file`);
      assert.equal(await ok(root, tool, { file_path: join(root, "not-yet", "nested", "new.txt") }), true, `${tool} new folders`);
      assert.equal(await ok(root, tool, { file_path: "a.txt" }), true, `${tool} relative`);
    }
  });

  it("refuses anything outside the folder, for reading and for writing", async () => {
    const { root, outside, base } = layout();
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.equal(await ok(root, tool, { file_path: join(outside, "secret.txt") }), false, tool);
      assert.equal(await ok(root, tool, { file_path: join(outside, "new.txt") }), false, `${tool} new`);
      assert.equal(await ok(root, tool, { file_path: join(base, "work-sibling", "x") }), false, `${tool} similar prefix`);
      assert.equal(await ok(root, tool, { file_path: base }), false, `${tool} parent`);
    }
  });

  it("refuses any parent-folder reference, even one that would stay inside", async () => {
    const { root } = layout();
    for (const p of ["../elsewhere/secret.txt", "sub/../../elsewhere/secret.txt", "..\\elsewhere\\secret.txt", `${root}${sep}sub${sep}..${sep}a.txt`]) {
      assert.equal(await ok(root, "Read", { file_path: p }), false, p);
    }
  });

  it("refuses a link inside the folder that leads outside, for existing and new files", async () => {
    const { root, outside } = layout();
    symlinkSync(outside, join(root, "link"), "junction");
    assert.equal(await ok(root, "Read", { file_path: join(root, "link", "secret.txt") }), false);
    assert.equal(await ok(root, "Write", { file_path: join(root, "link", "new.txt") }), false);
    assert.equal(await ok(root, "Edit", { file_path: join(root, "link", "deeper", "new.txt") }), false);
  });

  it("refuses odd or missing input instead of guessing", async () => {
    const { root } = layout();
    for (const input of [null, undefined, 5, "x", [], {}, { file_path: 5 }, { file_path: "" }, { file_path: "a.txt\0.png" }, { path: join(root, "a.txt") }]) {
      assert.equal(await ok(root, "Read", input), false, JSON.stringify(input));
    }
  });

  it("refuses Windows device and network paths", async () => {
    const { root } = layout();
    for (const p of ["\\\\server\\share\\x.txt", "\\\\.\\pipe\\x", "\\\\?\\C:\\Windows\\win.ini", "C:\\Windows\\win.ini", "/etc/passwd", "~/.ssh/id_rsa", "~"]) {
      assert.equal(await ok(root, "Read", { file_path: p }), false, p);
    }
  });
});

describe("folder guard: search tools", () => {
  it("allows searching inside the folder, with or without a path", async () => {
    const { root } = layout();
    assert.equal(await ok(root, "Glob", { pattern: "**/*.ts" }), true);
    assert.equal(await ok(root, "Glob", { pattern: "*.txt", path: join(root, "sub") }), true);
    assert.equal(await ok(root, "Grep", { pattern: "needle" }), true);
    assert.equal(await ok(root, "Grep", { pattern: "needle", path: "sub", glob: "*.ts" }), true);
  });

  it("refuses a search root outside the folder", async () => {
    const { root, outside } = layout();
    assert.equal(await ok(root, "Glob", { pattern: "*", path: outside }), false);
    assert.equal(await ok(root, "Grep", { pattern: "x", path: outside }), false);
    assert.equal(await ok(root, "Grep", { pattern: "x", path: ".." }), false);
  });

  it("refuses a file pattern that points outside the folder", async () => {
    const { root, outside } = layout();
    for (const pattern of [join(outside, "*"), "../**", "..\\*", "sub/../../*", "C:/Users/**", "\\\\host\\share\\*", "~/*", "/etc/*"]) {
      assert.equal(await ok(root, "Glob", { pattern }), false, `Glob ${pattern}`);
      assert.equal(await ok(root, "Grep", { pattern: "x", glob: pattern }), false, `Grep glob ${pattern}`);
    }
  });

  it("refuses a pattern that can expand to a parent folder, but allows ordinary brace patterns", async () => {
    const { root } = layout();
    for (const pattern of ["{..,x}/secret", "{..}/{..}/f", "sub/{..,deeper}/*"]) {
      assert.equal(await ok(root, "Glob", { pattern }), false, `Glob ${pattern}`);
      assert.equal(await ok(root, "Grep", { pattern: "x", glob: pattern }), false, `Grep ${pattern}`);
    }
    for (const pattern of ["src/**/*.{ts,tsx}", "*.{md,txt}", "**/{a,b}/*.json"]) {
      assert.equal(await ok(root, "Glob", { pattern }), true, `Glob ${pattern}`);
      assert.equal(await ok(root, "Grep", { pattern: "x", glob: pattern }), true, `Grep ${pattern}`);
    }
  });

  it("does not treat a search expression as a path", async () => {
    const { root } = layout();
    assert.equal(await ok(root, "Grep", { pattern: "C:\\\\Windows|/etc/passwd|\\.\\./" }), true);
  });

  it("refuses a search with odd input", async () => {
    const { root } = layout();
    assert.equal(await ok(root, "Glob", {}), false);
    assert.equal(await ok(root, "Glob", { pattern: 5 }), false);
    assert.equal(await ok(root, "Grep", { pattern: "x", path: 5 }), false);
  });
});

describe("folder guard: other tools", () => {
  it("allows web search and nothing else that is not a file tool", async () => {
    const { root } = layout();
    assert.equal(await ok(root, "WebSearch", { query: "nodejs" }), true);
    for (const tool of ["Bash", "PowerShell", "WebFetch", "Agent", "Task", "NotebookEdit", "TodoWrite", "mcp__x__y", ""]) {
      assert.equal(await ok(root, tool, { command: "echo hi" }), false, tool);
    }
  });
});

describe("folder guard: the hook", () => {
  const call = async (hooks: ReturnType<typeof folderGuardHooks>, tool: string, input: unknown) => {
    const matcher = hooks.PreToolUse?.[0];
    assert.ok(matcher);
    const hook = matcher.hooks[0];
    assert.ok(hook);
    return hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal });
  };

  it("fails closed: a failed check blocks the action", () => {
    const { root } = layout();
    assert.equal(folderGuardHooks(root).PreToolUse?.[0]?.onFailure, "block");
  });

  it("answers allow with nothing and deny with a reason, and reports each denial", async () => {
    const { root, outside } = layout();
    const denied: string[] = [];
    const hooks = folderGuardHooks(root, (tool) => denied.push(tool));
    assert.deepEqual(await call(hooks, "Read", { file_path: join(root, "a.txt") }), {});
    const out = (await call(hooks, "Read", { file_path: join(outside, "secret.txt") })) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0);
    assert.ok(!out.hookSpecificOutput.permissionDecisionReason.includes(outside), "the reason does not echo the path");
    await call(hooks, "Bash", { command: "echo hi" });
    assert.deepEqual(denied, ["Read", "Bash"]);
  });

  it("denies, rather than throws, when the check itself breaks", async () => {
    const hooks = folderGuardHooks("Z:\\root\\that\\does\\not\\exist");
    const out = (await call(hooks, "Read", { file_path: "a.txt" })) as { hookSpecificOutput: { permissionDecision: string } };
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  });
});
