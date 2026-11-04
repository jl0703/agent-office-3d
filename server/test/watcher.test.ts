import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import type { ServerEvent } from "../../shared/events.ts";
import { createRegistry } from "../src/registry.ts";
import { projectsRoot, startWatcher, type Watcher } from "../src/watcher.ts";

const SESSION = "11111111-aaaa-bbbb-cccc-222222222222";
const CWD = "C:\\work\\demo";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const userLine = (extra: object = {}) =>
  line({ type: "user", timestamp: new Date().toISOString(), cwd: CWD, sessionId: SESSION, message: { content: "hello" }, ...extra });
const toolLine = (id: string, name = "Edit", input: object = { file_path: "C:\\work\\demo\\src\\app.ts" }) =>
  line({ type: "assistant", timestamp: new Date().toISOString(), cwd: CWD, message: { content: [{ type: "tool_use", id, name, input }] } });
const resultLine = (id: string) =>
  line({ type: "user", timestamp: new Date().toISOString(), cwd: CWD, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

const roots: string[] = [];
const watchers: Watcher[] = [];
after(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function rig(opts: { idleMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "projects-"));
  roots.push(root);
  const project = join(root, "c--work-demo");
  mkdirSync(project);
  const registry = createRegistry({ idleMs: opts.idleMs ?? 15_000 });
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  const logs: Record<string, unknown>[] = [];
  const start = async (o: Partial<Parameters<typeof startWatcher>[0]> = {}) => {
    const w = await startWatcher({ root, registry, sweepMs: 60_000, log: (l) => logs.push(l), ...o });
    watchers.push(w);
    return w;
  };
  const file = (id = SESSION) => join(project, `${id}.jsonl`);
  return { root, project, registry, events, logs, start, file };
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`condition not met within ${ms} ms`);
}

describe("watcher", () => {
  it("finds a session that already exists and reads its project, title, and task", async () => {
    const r = rig();
    writeFileSync(
      r.file(),
      line({ type: "ai-title", sessionId: SESSION, aiTitle: "Fix the login" }) +
        line({ type: "last-prompt", lastPrompt: "please   fix\nlogin" }) +
        userLine(),
    );
    await r.start();
    const a = r.registry.get(SESSION);
    assert.ok(a);
    assert.equal(a.kind, "session");
    assert.equal(a.project, "demo");
    assert.equal(a.name, "Fix the login");
    assert.equal(a.currentTask, "please fix login");
    assert.equal(a.status, "working");
  });

  it("does not list a quiet session, and lists it again after its next write", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(r.file(), old, old);
    const w = await r.start({ staleMs: 10 * 60_000 });
    assert.equal(r.registry.has(SESSION), false);
    appendFileSync(r.file(), toolLine("t1"));
    await w.scan();
    assert.equal(r.registry.has(SESSION), true);
  });

  it("removes a session once it has been quiet for the stale window", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const w = await r.start({ staleMs: 10 * 60_000 });
    assert.equal(r.registry.has(SESSION), true);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(r.file(), old, old);
    await w.scan();
    assert.equal(r.registry.has(SESSION), false);
    assert.ok(r.events.some((e) => e.type === "agent.removed"));
  });

  it("notices a new session through file watching, with the backup sweep far away (QR-1)", async () => {
    const r = rig();
    await r.start({ sweepMs: 600_000 });
    const t0 = Date.now();
    writeFileSync(r.file(), userLine());
    await waitFor(() => r.registry.has(SESSION), 2000);
    assert.ok(Date.now() - t0 < 2000);
  });

  it("follows appended tool calls and their results", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    await r.start({ sweepMs: 600_000 });
    appendFileSync(r.file(), toolLine("t1", "Bash", { command: "echo SECRET", description: "Run tests" }));
    await waitFor(() => r.registry.get(SESSION)?.tool === "Bash", 2000);
    assert.equal(r.registry.get(SESSION)?.activity, "Bash Run tests");
    assert.equal(r.registry.pendingCount(SESSION), 1);
    appendFileSync(r.file(), resultLine("t1"));
    await waitFor(() => r.registry.pendingCount(SESSION) === 0, 2000);
    assert.ok(!JSON.stringify(r.events).includes("SECRET"));
  });

  it("goes idle on the backup sweep when nothing happens", async () => {
    const r = rig({ idleMs: 80 });
    writeFileSync(r.file(), userLine());
    await r.start({ sweepMs: 40 });
    assert.equal(r.registry.get(SESSION)?.status, "working");
    await waitFor(() => r.registry.get(SESSION)?.status === "idle", 3000);
  });

  it("waits for the rest of a half-written line and processes it once", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const w = await r.start();
    const whole = toolLine("t1");
    const cut = Math.floor(whole.length / 2);
    appendFileSync(r.file(), whole.slice(0, cut));
    await w.scan();
    assert.equal(r.registry.get(SESSION)?.tool, null);
    appendFileSync(r.file(), whole.slice(cut));
    await w.scan();
    await w.scan();
    assert.equal(r.events.filter((e) => e.type === "agent.activity").length, 1);
  });

  it("decodes a multi-byte character that is split between two reads", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const w = await r.start();
    const bytes = Buffer.from(line({ type: "ai-title", aiTitle: "Café ☕ plan" }));
    const split = bytes.indexOf(0xe2) + 1; // inside the three-byte coffee cup
    appendFileSync(r.file(), bytes.subarray(0, split));
    await w.scan();
    appendFileSync(r.file(), bytes.subarray(split));
    await w.scan();
    assert.equal(r.registry.get(SESSION)?.name, "Café ☕ plan");
  });

  it("nests a subagent under its parent and marks it done when its metadata says finished", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const dir = join(r.project, SESSION, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-abc123.jsonl"), userLine({ sessionId: SESSION, agentId: "abc123" }));
    writeFileSync(join(dir, "agent-abc123.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", finished: false }));
    const w = await r.start();
    const sub = r.registry.get("agent-abc123");
    assert.ok(sub);
    assert.equal(sub.kind, "subagent");
    assert.equal(sub.parentId, SESSION);
    assert.equal(sub.name, "Explore");
    assert.equal(sub.currentTask, "Look around");
    assert.notEqual(sub.status, "done");
    writeFileSync(join(dir, "agent-abc123.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", finished: true }));
    await w.scan();
    assert.equal(r.registry.get("agent-abc123")?.status, "done");
  });

  it("skips malformed lines and warns once per unknown type", async () => {
    const r = rig();
    writeFileSync(
      r.file(),
      "not json at all\n" +
        '{"half":\n' +
        line({ type: "brand-new-thing", cwd: CWD }) +
        line({ type: "brand-new-thing", cwd: CWD }) +
        line({ type: "api-request-blob", cwd: CWD }) +
        userLine() +
        toolLine("t1"),
    );
    await r.start();
    assert.equal(r.registry.get(SESSION)?.tool, "Edit");
    const warns = r.logs.filter((l) => l["event"] === "warn");
    assert.equal(warns.filter((l) => String(l["key"]).startsWith("type:brand-new-thing")).length, 1);
    assert.equal(warns.filter((l) => String(l["key"]).startsWith("malformed:")).length, 1);
    assert.equal(warns.filter((l) => String(l["key"]).includes("api-request-blob")).length, 0);
  });

  it("skips lines over the size limit, including ones that span several reads", async () => {
    const r = rig();
    const huge = line({ type: "assistant", cwd: CWD, message: { content: [{ type: "text", text: "x".repeat(700_000) }] } });
    writeFileSync(r.file(), userLine() + huge + toolLine("t1") + huge + toolLine("t2", "Read", { file_path: "z.ts" }));
    const w = await r.start({ maxLineBytes: 100_000, tailBytes: 5_000_000 });
    await w.scan();
    assert.equal(r.registry.get(SESSION)?.activity, "Read z.ts");
    assert.equal(r.logs.filter((l) => String(l["key"]).startsWith("oversize:")).length, 1);
  });

  it("skips a too-long line that arrives inside a single read", async () => {
    const r = rig();
    const long = line({ type: "assistant", cwd: CWD, message: { content: [{ type: "tool_use", id: "big", name: "Read", input: { file_path: "should-not-appear.ts" } }, { type: "text", text: "x".repeat(5000) }] } });
    writeFileSync(r.file(), userLine() + long + toolLine("t1", "Read", { file_path: "after.ts" }));
    await r.start({ maxLineBytes: 2000 });
    assert.equal(r.registry.get(SESSION)?.activity, "Read after.ts");
    assert.ok(!r.events.some((e) => e.type === "agent.activity" && e.summary.includes("should-not-appear")));
    assert.equal(r.logs.filter((l) => String(l["key"]).startsWith("oversize:")).length, 1);
  });

  it("reads only the tail of a big file and drops the cut-off first line", async () => {
    const r = rig();
    let text = "";
    for (let i = 0; i < 300; i++) text += toolLine(`old${i}`, "Read", { file_path: `old${i}.ts` });
    text += userLine() + toolLine("last", "Write", { file_path: "final.ts" });
    writeFileSync(r.file(), text);
    await r.start({ tailBytes: 4096 });
    assert.equal(r.registry.get(SESSION)?.activity, "Write final.ts");
    assert.ok(r.registry.pendingCount(SESSION) < 100, "old history was not replayed");
  });

  it("ignores odd names, stray files, and files outside a project folder", async () => {
    const r = rig();
    for (const name of ["bad name.jsonl", "a.b.jsonl", ".jsonl", "notes.txt", "x.jsonl.bak"]) writeFileSync(join(r.project, name), userLine());
    writeFileSync(join(r.root, "stray.jsonl"), userLine());
    mkdirSync(join(r.project, "weird dir", "subagents"), { recursive: true });
    writeFileSync(join(r.project, "weird dir", "subagents", "agent-x.jsonl"), userLine());
    await r.start();
    assert.equal(r.registry.size(), 0);
  });

  it("does not follow symbolic links", async (t) => {
    const r = rig();
    const outside = join(r.root, "..", `outside-${Date.now()}.jsonl`);
    writeFileSync(outside, userLine());
    roots.push(outside);
    try {
      symlinkSync(outside, r.file());
    } catch {
      t.skip("cannot create symbolic links here");
      return;
    }
    await r.start();
    assert.equal(r.registry.size(), 0);
  });

  it("does not follow a linked project folder", async () => {
    const r = rig();
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    roots.push(elsewhere);
    writeFileSync(join(elsewhere, `${SESSION}.jsonl`), userLine());
    symlinkSync(elsewhere, join(r.root, "linked-project"), "junction"); // works without special rights on Windows
    await r.start();
    assert.equal(r.registry.size(), 0);
  });

  it("removes a session whose file is deleted", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const w = await r.start();
    assert.equal(r.registry.has(SESSION), true);
    rmSync(r.file());
    await w.scan();
    assert.equal(r.registry.has(SESSION), false);
  });

  it("starts over when a file is replaced by a shorter one", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine() + toolLine("t1") + toolLine("t2"));
    const w = await r.start();
    truncateSync(r.file(), 0);
    appendFileSync(r.file(), userLine() + toolLine("t9", "Glob", { pattern: "*.ts" }));
    await w.scan();
    assert.equal(r.registry.get(SESSION)?.activity, "Glob *.ts");
    assert.equal(r.registry.pendingCount(SESSION), 1, "calls from the old file are forgotten");
  });

  it("does not follow a linked subagents folder", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    roots.push(elsewhere);
    writeFileSync(join(elsewhere, "agent-linked.jsonl"), userLine());
    mkdirSync(join(r.project, SESSION));
    symlinkSync(elsewhere, join(r.project, SESSION, "subagents"), "junction");
    await r.start();
    assert.equal(r.registry.has(SESSION), true);
    assert.equal(r.registry.has("agent-linked"), false);
  });

  it("stops tracking new agents at the limit and warns once", async () => {
    const r = rig();
    for (const id of ["s1", "s2", "s3"]) writeFileSync(r.file(id), userLine());
    await r.start({ maxAgents: 2 });
    assert.equal(r.registry.size(), 2);
    assert.equal(r.logs.filter((l) => l["key"] === "cap").length, 1);
  });

  it("skips the log of a worker the app started", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine() + toolLine("t1"));
    writeFileSync(r.file("other-session"), userLine());
    await r.start({ isManaged: (id) => id === SESSION });
    assert.equal(r.registry.has(SESSION), false);
    assert.equal(r.registry.has("other-session"), true, "other sessions are still watched");
  });

  it("holds back new logs while a worker is starting, then lists only the ones that are not its own", async () => {
    const r = rig();
    let starting = true;
    let owned = false;
    writeFileSync(r.file(), userLine());
    writeFileSync(r.file("mine"), userLine());
    const w = await r.start({ startPending: () => starting, isManaged: (id) => owned && id === "mine" });
    assert.equal(r.registry.size(), 0, "nothing is adopted during the start");
    starting = false;
    owned = true;
    await w.scan();
    assert.equal(r.registry.has(SESSION), true);
    assert.equal(r.registry.has("mine"), false);
  });

  it("does not hold back sessions it already follows while a worker is starting", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine());
    let starting = false;
    const w = await r.start({ startPending: () => starting });
    starting = true;
    appendFileSync(r.file(), toolLine("t1", "Read", { file_path: "z.ts" }));
    await w.scan();
    assert.equal(r.registry.get(SESSION)?.activity, "Read z.ts");
  });

  it("finds new files with the backup sweep alone when file watching is off", async () => {
    const r = rig();
    await r.start({ watch: false, sweepMs: 40 });
    writeFileSync(r.file(), userLine());
    await waitFor(() => r.registry.has(SESSION), 3000);
  });

  it("starts even when the log folder does not exist yet, and picks it up later", async () => {
    const r = rig();
    const missing = join(r.root, "later");
    const w = await startWatcher({ root: missing, registry: r.registry, sweepMs: 40, log: (l) => r.logs.push(l) });
    watchers.push(w);
    assert.equal(r.registry.size(), 0);
    mkdirSync(join(missing, "p1"), { recursive: true });
    writeFileSync(join(missing, "p1", `${SESSION}.jsonl`), userLine());
    await waitFor(() => r.registry.has(SESSION), 3000);
  });

  it("writes nothing under the log folder (QR-6)", async () => {
    const r = rig();
    writeFileSync(r.file(), userLine() + toolLine("t1"));
    mkdirSync(join(r.project, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(r.project, SESSION, "subagents", "agent-q.jsonl"), userLine());
    const tree = () => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          const s = statSync(p);
          out.push(`${relative(r.root, p)}|${s.size}|${s.mtimeMs}|${s.isDirectory()}`);
          if (s.isDirectory()) walk(p);
        }
      };
      walk(r.root);
      return out.sort();
    };
    const before = tree();
    const w = await r.start({ sweepMs: 20 });
    await w.scan();
    await new Promise((res) => setTimeout(res, 150));
    await w.close();
    assert.deepEqual(tree(), before);
  });

  it("only ever looks inside the projects folder, never next to it", () => {
    assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: "D:\\cfg" }, "C:\\Users\\me"), join("D:\\cfg", "projects"));
    assert.equal(projectsRoot({}, "C:\\Users\\me"), join("C:\\Users\\me", ".claude", "projects"));
    assert.ok(!projectsRoot({}, "C:\\Users\\me").includes("sessions"));
    assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: "" }, "C:\\Users\\me"), join("C:\\Users\\me", ".claude", "projects"));
  });
});
