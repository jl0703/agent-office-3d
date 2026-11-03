import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./app.ts";
import { createRegistry } from "./registry.ts";
import { projectsRoot, startWatcher } from "./watcher.ts";

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`${name} must be a number from ${min} to ${max}`);
    process.exit(1);
  }
  return value;
}

const publicPortRaw = process.env["OFFICE_PUBLIC_PORT"];
const publicPort = publicPortRaw === undefined ? undefined : numberFromEnv("OFFICE_PUBLIC_PORT", 0, 1, 65535);
const staleMinutes = numberFromEnv("OFFICE_STALE_MINUTES", 15, 1, 24 * 60);

const registry = createRegistry();
const watcher = await startWatcher({
  root: projectsRoot(process.env, homedir()),
  registry,
  staleMs: staleMinutes * 60_000,
});
const app = await startServer({
  port: numberFromEnv("OFFICE_PORT", 4777, 1, 65535),
  publicPort,
  staticDir: fileURLToPath(new URL("../../client/dist", import.meta.url)),
  registry,
});

// The only place the token is printed. It works once.
console.log(
  `Open this one-time URL in your browser:\nhttp://127.0.0.1:${publicPort ?? app.port}/api/session?t=${app.token}`,
);

process.once("SIGINT", () => void Promise.all([app.close(), watcher.close()]).then(() => process.exit(0)));
