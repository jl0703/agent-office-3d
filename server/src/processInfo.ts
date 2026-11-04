import { execFile } from "node:child_process";
import { killTree as defaultKillTree } from "./killTree.ts";
import type { StoredWorker } from "./managedStore.ts";

export type ProcessInfo = { name: string; startedAtMs: number };

// `ps` reports the start only to the second, so two lookups of one process can differ a little.
const START_TOLERANCE_MS = 2000;

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

/** Name and start time of a live process, or null when there is none with that id. */
export async function inspectProcess(pid: number): Promise<ProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    // `pid` is a checked integer, so it cannot add anything to the command.
    const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessName + '|' + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()`;
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    const [name, start] = (out ?? "").split("|");
    return name && /^\d+$/.test(start ?? "") ? { name, startedAtMs: Number(start) } : null;
  }
  const out = await run("ps", ["-o", "etimes=,comm=", "-p", String(pid)]);
  const match = /^(\d+)\s+(.+)$/.exec(out ?? "");
  return match ? { name: match[2] as string, startedAtMs: Date.now() - Number(match[1]) * 1000 } : null;
}

type Cleanup = {
  inspect?: (pid: number) => Promise<ProcessInfo | null>;
  kill?: (pid: number) => Promise<void>;
};

/**
 * Stops processes that outlived a previous run. A process is touched only when both its name and its
 * start time match what was recorded, so a reused process id (or an edited file) cannot hit anything else.
 * Returns how many were stopped.
 */
export async function killLeftovers(workers: StoredWorker[], { inspect = inspectProcess, kill = defaultKillTree }: Cleanup = {}): Promise<number> {
  let killed = 0;
  for (const w of workers) {
    if (w.pid === null || w.processName === null || w.pidStartedAt === null || w.pid === process.pid) continue;
    const live = await inspect(w.pid);
    if (!live || live.name !== w.processName || Math.abs(live.startedAtMs - w.pidStartedAt) > START_TOLERANCE_MS) continue;
    await kill(w.pid);
    killed++;
  }
  return killed;
}
