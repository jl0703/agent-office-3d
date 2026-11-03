import { spawn } from "node:child_process";

/**
 * Kills a process and everything it started. Windows uses taskkill; elsewhere the process
 * must have been started as the leader of its own group (`detached: true`), which the
 * supervisor does.
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    resolve();
  });
}
