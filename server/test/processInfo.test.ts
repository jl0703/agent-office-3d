import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, describe, it } from "node:test";
import { inspectProcess, killLeftovers } from "../src/processInfo.ts";
import { storedWorker } from "./fakeQuery.ts";

const started: ChildProcess[] = [];
after(() => {
  for (const c of started) c.kill("SIGKILL");
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("condition not met");
}
/** A harmless process that does nothing until it is killed. */
function idleProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  started.push(child);
  return child;
}

describe("process lookup", () => {
  it("reports the name and start time of a live process, and nothing for a missing one", async () => {
    const info = await inspectProcess(process.pid);
    assert.ok(info && info.name.length > 0);
    assert.ok(info.startedAtMs <= Date.now() && info.startedAtMs > Date.now() - 24 * 3_600_000);
    assert.equal(await inspectProcess(2 ** 31 - 2), null);
    assert.equal(await inspectProcess(-1), null);
    assert.equal(await inspectProcess(1.5), null);
  });
});

describe("leftover processes", () => {
  it("stops a real leftover process whose name and start time match, and leaves ones that do not", async () => {
    const [match, wrongStart, wrongName] = [idleProcess(), idleProcess(), idleProcess()] as [ChildProcess, ChildProcess, ChildProcess];
    const [a, b, c] = await Promise.all([match, wrongStart, wrongName].map((p) => inspectProcess(p.pid as number)));
    assert.ok(a && b && c, "the processes can be looked up");

    const killed = await killLeftovers([
      storedWorker("match", { pid: match.pid as number, processName: a.name, pidStartedAt: a.startedAtMs }),
      // The same number, but the recorded start is an hour off: it is a different process that reused the id.
      storedWorker("wrong-start", { pid: wrongStart.pid as number, processName: b.name, pidStartedAt: b.startedAtMs - 3_600_000 }),
      storedWorker("wrong-name", { pid: wrongName.pid as number, processName: `not-${c.name}`, pidStartedAt: c.startedAtMs }),
    ]);

    assert.equal(killed, 1);
    await waitFor(() => !alive(match.pid as number));
    assert.ok(alive(wrongStart.pid as number), "a process with another start time is left alone");
    assert.ok(alive(wrongName.pid as number), "a process with another name is left alone");
  });

  it("does nothing for workers without a recorded process, for a process that is gone, and never for this server", async () => {
    const killed: number[] = [];
    const self = { name: "node", startedAtMs: 1000 };
    const count = await killLeftovers(
      [
        storedWorker("none"),
        storedWorker("partial", { pid: 10, processName: "node", pidStartedAt: null }),
        storedWorker("gone", { pid: 11, processName: "node", pidStartedAt: 1000 }),
        storedWorker("self", { pid: process.pid, processName: "node", pidStartedAt: 1000 }),
      ],
      { inspect: async (pid) => (pid === 11 ? null : self), kill: async (pid) => void killed.push(pid) },
    );
    assert.equal(count, 0);
    assert.deepEqual(killed, []);
  });

  it("accepts a small difference in start time, since some systems report it to the second", async () => {
    const killed: number[] = [];
    const count = await killLeftovers([storedWorker("a", { pid: 10, processName: "node", pidStartedAt: 10_000 })], {
      inspect: async () => ({ name: "node", startedAtMs: 11_500 }),
      kill: async (pid) => void killed.push(pid),
    });
    assert.deepEqual([count, killed], [1, [10]]);
  });
});
