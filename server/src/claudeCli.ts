import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Runs the owner's own `claude` program (never through a shell). On Windows `claude` is usually a small .cmd shim that
// points at claude.exe; a .cmd file cannot be started without a shell, so the exe it points to is used directly.

type Exists = (path: string) => boolean;

/** The claude executable: OFFICE_CLAUDE_BIN if set, else found on PATH. Null when there is none. */
export function findClaude(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: Exists = existsSync): string | null {
  const override = env["OFFICE_CLAUDE_BIN"];
  if (override) return exists(override) ? override : null;
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (platform === "win32") {
      const exe = join(dir, "claude.exe");
      if (exists(exe)) return exe;
      const shimTarget = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (exists(join(dir, "claude.cmd")) && exists(shimTarget)) return shimTarget;
    } else {
      const bin = join(dir, "claude");
      if (exists(bin)) return bin;
    }
  }
  return null;
}

export type ClaudeRunner = (args: string[]) => Promise<{ ok: boolean }>;

/** A runner for the program at `bin`. Output is never returned, because it can echo the arguments, which may hold secrets. */
export const claudeRunner =
  (bin: string): ClaudeRunner =>
  (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error) => resolve({ ok: !error }));
    });
