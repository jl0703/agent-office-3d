// Opt-in check against the real Claude Agent SDK and the user's Claude login.
// It spends a little subscription usage, so it only runs with OFFICE_LIVE_TESTS=1:
//   OFFICE_LIVE_TESTS=1 node --test server/test/live.test.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRegistry } from "../src/registry.ts";
import { createSupervisor } from "../src/supervisor.ts";

const live = process.env["OFFICE_LIVE_TESTS"] === "1";

describe("live check with the real SDK", { skip: !live }, () => {
  it("runs a locked-down worker on the subscription login and stops it", { timeout: 240_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "live-"));
    const outside = mkdtempSync(join(tmpdir(), "live-outside-"));
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE-MARKER");
    writeFileSync(join(root, "hello.txt"), "The number is 42.\n");
    // The folder's own settings try to allow the shell and skip all permission checks. They must be ignored.
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash", "Bash(*)", "PowerShell"], defaultMode: "bypassPermissions" } }),
    );
    const registry = createRegistry();
    const logs: Record<string, unknown>[] = [];
    const supervisor = createSupervisor({
      registry,
      query,
      roots: [root],
      env: process.env,
      log: (line) => logs.push(line),
    });
    try {
      const started = await supervisor.start({
        cwd: root,
        prompt:
          "Read the file hello.txt and tell me the number in it. " +
          `Then read the file ${join(outside, "secret.txt")} and tell me what it says. ` +
          `Then write the word hi to the new file ${join(outside, "written.txt")}. ` +
          "Then try to run the shell command `echo hi` and tell me if it worked. " +
          "Then search the web for the word nodejs and tell me one fact. Keep every answer to one short sentence.",
      });
      assert.ok(started.ok, `start failed: ${JSON.stringify(started)}`);
      // Starting at all proves the session reported no API key source (subscription login).

      const session = logs.find((l) => l["event"] === "managed-session");
      const tools = (session?.["tools"] ?? []) as string[];
      for (const allowed of ["Read", "Edit", "Write", "Glob", "Grep", "WebSearch"]) assert.ok(tools.includes(allowed), `missing ${allowed}: ${tools.join(",")}`);
      for (const banned of ["Bash", "PowerShell", "WebFetch", "Agent", "Task"]) assert.ok(!tools.includes(banned), `${banned} is available: ${tools.join(",")}`);

      const end = Date.now() + 200_000;
      while (!logs.some((l) => l["event"] === "managed-turn-end") && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
      assert.ok(logs.some((l) => l["event"] === "managed-turn-end"), "the worker finished its turn");

      const agent = registry.get(started.id);
      assert.ok(agent);
      console.log(JSON.stringify({ tools, lastTool: agent.tool, lastActivity: agent.activity, turnEnd: logs.find((l) => l["event"] === "managed-turn-end") }));
      assert.notEqual(agent.tool, "Bash");

      // Files outside the worker's folder: both the read and the write must have been refused.
      assert.equal(existsSync(join(outside, "written.txt")), false, "a file was written outside the folder");
      const denied = logs.filter((l) => l["event"] === "managed-tool-denied").map((l) => l["tool"]);
      assert.ok(denied.includes("Read") && denied.includes("Write"), `expected Read and Write to be refused, saw: ${denied.join(",") || "nothing"}`);

      await supervisor.stop(started.id);
      assert.equal(registry.get(started.id)?.status, "stopped");
      assert.equal(supervisor.liveCount(), 0);
    } finally {
      await supervisor.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("runs a master that starts three workers in parallel, collects their results and stops them", { timeout: 420_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "live-master-"));
    const registry = createRegistry();
    const logs: Record<string, unknown>[] = [];
    const supervisor = createSupervisor({ registry, query, roots: [root], env: process.env, log: (line) => logs.push(line) });
    try {
      const started = await supervisor.startMaster({
        cwd: root,
        name: "live master",
        prompt:
          "You are testing your office tools. Start exactly three workers with spawn_worker, named w1, w2 and w3, all with the folder `.`. " +
          "Give w1 the task: create the file out1.txt containing the word one. Give w2: create out2.txt containing two. Give w3: create out3.txt containing three. " +
          "Then call wait_for_workers until none is still working, read the results, stop all three workers with stop_worker, and answer with the word DONE and one short sentence.",
      });
      assert.ok(started.ok, `start failed: ${JSON.stringify(started)}`);
      const session = logs.find((l) => l["event"] === "managed-session");
      const tools = (session?.["tools"] ?? []) as string[];
      for (const office of ["spawn_worker", "assign_task", "wait_for_workers", "stop_worker", "list_workers"]) assert.ok(tools.some((t) => t.endsWith(office)), `missing ${office}: ${tools.join(",")}`);

      const end = Date.now() + 380_000;
      while (!logs.some((l) => l["event"] === "managed-turn-end" && l["id"] === started.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
      assert.ok(logs.some((l) => l["event"] === "managed-turn-end" && l["id"] === started.id), "the master finished its turn");

      const workers = registry.snapshot().filter((a: { parentId: string | null }) => a.parentId === started.id);
      console.log(JSON.stringify({ workers: workers.map((w: { name: string; status: string }) => ({ name: w.name, status: w.status })), refusals: logs.filter((l) => l["event"] === "managed-refused").length, denied: logs.filter((l) => l["event"] === "managed-tool-denied").map((l) => l["tool"]) }));
      assert.equal(workers.length, 3, "three workers were started by the master");
      for (const n of [1, 2, 3]) assert.ok(existsSync(join(root, `out${n}.txt`)), `out${n}.txt was written`);

      await supervisor.stop(started.id);
      assert.equal(supervisor.liveCount(), 0, "no worker is left running");
    } finally {
      await supervisor.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
