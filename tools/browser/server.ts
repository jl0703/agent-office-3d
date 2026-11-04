import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export type TestServer = { base: string; token: string; stop: () => void };

process.once("SIGINT", () => process.exit(130)); // Ctrl+C runs the exit handlers that clean up

let nextPort = 4793;
const running: (() => void)[] = [];

/** Stops every server started with startServer. Call it in a `finally`. */
export const stopAllServers = () => running.splice(0).forEach((stop) => stop());

/**
 * The real server, served like for a user. It watches an empty folder, so no real session
 * (and no real name) can show up in a screenshot. The login URL works once: use one server per browser.
 */
export async function startServer(): Promise<TestServer> {
  const port = nextPort++;
  const config = mkdtempSync(join(tmpdir(), "office-empty-"));
  const child = spawn(process.execPath, ["server/src/main.ts"], {
    env: { ...process.env, OFFICE_PORT: String(port), CLAUDE_CONFIG_DIR: config },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const stop = () => {
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
      else child.kill("SIGKILL");
    } catch {
      // already gone
    }
    rmSync(config, { recursive: true, force: true });
  };
  running.push(stop);
  process.once("exit", stop);
  await until(() => /session\?t=/.test(output), 20000, "the server");
  return { base: `http://127.0.0.1:${port}`, token: /session\?t=([0-9a-f]+)/.exec(output)?.[1] ?? "", stop };
}
