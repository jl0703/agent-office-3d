import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { inspectProcess } from "../src/processInfo.ts";
import { saveStore, STORE_FILE } from "../src/managedStore.ts";
import { storedWorker } from "./fakeQuery.ts";

const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((fn) => fn()));

describe("server startup", () => {
  it("does not touch the first instance's workers or file when the port is already taken", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    // Stands in for a worker process of the instance that is already running.
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    cleanup.push(() => worker.kill("SIGKILL"));
    const info = await inspectProcess(worker.pid as number);
    assert.ok(info);
    await saveStore(dir, [storedWorker("w-1", { cwd: dir, pid: worker.pid as number, processName: info.name, pidStartedAt: info.startedAtMs })]);
    const before = readFileSync(join(dir, STORE_FILE), "utf8");

    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => holder.close());
    const port = (holder.address() as net.AddressInfo).port;

    const second = spawn(process.execPath, ["server/src/main.ts"], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OFFICE_PORT: String(port), OFFICE_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir, OFFICE_ALLOWED_ROOTS: dir },
    });
    cleanup.push(() => second.kill("SIGKILL"));
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));

    assert.notEqual(code, 0, "the second instance fails to start");
    assert.equal(worker.exitCode, null, "the first instance's worker is still running");
    assert.equal(worker.signalCode, null);
    assert.equal(readFileSync(join(dir, STORE_FILE), "utf8"), before, "the file is not rewritten");
  });
});
