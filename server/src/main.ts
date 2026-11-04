import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./app.ts";
import { DEFAULT_SESSION_BUDGET_USD, DEFAULT_TOTAL_BUDGET_USD } from "./budget.ts";
import { parseRoots } from "./paths.ts";
import { createRegistry } from "./registry.ts";
import { createSupervisor } from "./supervisor.ts";
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
// Workers may only use these folders. Unset, that is just the folder the server was started in.
const roots = parseRoots(process.env["OFFICE_ALLOWED_ROOTS"], process.cwd());

const registry = createRegistry();
const projectsDir = projectsRoot(process.env, homedir());
const supervisor = createSupervisor({
  registry,
  query,
  roots,
  env: process.env,
  maxManaged: numberFromEnv("MAX_MANAGED", 6, 1, 20),
  dataDir: process.env["OFFICE_DATA_DIR"] || fileURLToPath(new URL("../../data", import.meta.url)),
  projectsDir,
  sessionBudgetUsd: numberFromEnv("OFFICE_SESSION_BUDGET_USD", DEFAULT_SESSION_BUDGET_USD, 0.01, 1000),
  totalBudgetUsd: numberFromEnv("OFFICE_TOTAL_BUDGET_USD", DEFAULT_TOTAL_BUDGET_USD, 0.01, 10_000),
});
const app = await startServer({
  port: numberFromEnv("OFFICE_PORT", 4777, 1, 65535),
  publicPort,
  staticDir: fileURLToPath(new URL("../../client/dist", import.meta.url)),
  registry,
  supervisor,
});

// Only now, with the port bound: a second instance that fails to bind must not touch the first one's workers.
// Stop leftover processes and list earlier workers as detached. Nothing restarts.
await supervisor.recover();
const watcher = await startWatcher({
  root: projectsDir,
  registry,
  staleMs: staleMinutes * 60_000,
  isManaged: supervisor.claims,
  startPending: supervisor.starting,
});

console.log(`Workers may use these folders: ${roots.join(", ")}`);
// The only place the token is printed. It works once.
console.log(
  `Open this one-time URL in your browser:\nhttp://127.0.0.1:${publicPort ?? app.port}/api/session?t=${app.token}`,
);

// Stop every worker before leaving, so no agent process is left running.
process.once("SIGINT", () => {
  void supervisor
    .close()
    .then(() => Promise.all([app.close(), watcher.close()]))
    .then(() => process.exit(0));
});
