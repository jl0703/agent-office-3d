import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./app.ts";
import { DEFAULT_SESSION_BUDGET_USD, DEFAULT_TOTAL_BUDGET_USD } from "./budget.ts";
import { createDecisionStore, ensureResearchLayout } from "./findings.ts";
import { PLANS_LOG_DIR } from "./planLog.ts";
import { createGithub } from "./github.ts";
import { createScheduleStore, createScheduler } from "./schedule.ts";
import { DEFAULT_SWEEP_BUDGET_USD, sweepPromptFor } from "./sweep.ts";
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
// The research team's folder: set explicitly, else inside the vault. It is the only part of the vault workers may use.
const vaultDir = process.env["OFFICE_VAULT_DIR"];
const researchSetting = process.env["OFFICE_RESEARCH_DIR"] || (vaultDir ? join(vaultDir, "agent-workspace", "research") : undefined);
let researchDir: string | undefined;
if (researchSetting && isAbsolute(researchSetting)) {
  try {
    await mkdir(researchSetting, { recursive: true });
    await ensureResearchLayout(researchSetting);
    researchDir = researchSetting;
    roots.push(researchDir);
  } catch {
    console.error("The research folder could not be created; the research team is off.");
  }
}

const dataDir = process.env["OFFICE_DATA_DIR"] || fileURLToPath(new URL("../../data", import.meta.url));
// Outcome notes of ended masters go next to the research folder, in the vault only.
const plansLogDir = vaultDir && isAbsolute(vaultDir) ? join(vaultDir, "agent-workspace", PLANS_LOG_DIR) : undefined;
const decisions = researchDir ? createDecisionStore(dataDir) : undefined;
const registry = createRegistry();
const projectsDir = projectsRoot(process.env, homedir());
const supervisor = createSupervisor({
  registry,
  query,
  roots,
  ...(researchDir ? { researchDir } : {}),
  ...(plansLogDir ? { plansLogDir } : {}),
  ...(decisions ? { decisions } : {}),
  github: createGithub({ token: process.env["GITHUB_TOKEN"] }),
  env: process.env,
  maxManaged: numberFromEnv("MAX_MANAGED", 8, 1, 20),
  maxMasters: numberFromEnv("MAX_MASTERS", 1, 1, 5),
  maxWorkersPerMaster: numberFromEnv("MAX_WORKERS_PER_MASTER", 5, 1, 19),
  dataDir,
  projectsDir,
  sessionBudgetUsd: numberFromEnv("OFFICE_SESSION_BUDGET_USD", DEFAULT_SESSION_BUDGET_USD, 0.01, 1000),
  totalBudgetUsd: numberFromEnv("OFFICE_TOTAL_BUDGET_USD", DEFAULT_TOTAL_BUDGET_USD, 0.01, 10_000),
  sweepBudgetUsd: numberFromEnv("OFFICE_SWEEP_BUDGET_USD", DEFAULT_SWEEP_BUDGET_USD, 0.01, 1000),
});
const scheduler =
  researchDir && decisions
    ? createScheduler({
        store: createScheduleStore(dataDir),
        startSweep: async () => supervisor.startSweep(await sweepPromptFor(researchDir, decisions)),
        usage: supervisor.usage,
      })
    : undefined;
const app = await startServer({
  port: numberFromEnv("OFFICE_PORT", 4777, 1, 65535),
  publicPort,
  // Set by `npm run dev` only, so the link and login survive its auto-restarts.
  ...(process.env["OFFICE_SESSION_SECRET"] ? { sessionSecret: process.env["OFFICE_SESSION_SECRET"] } : {}),
  staticDir: fileURLToPath(new URL("../../client/dist", import.meta.url)),
  registry,
  supervisor,
  ...(researchDir ? { researchDir } : {}),
  ...(decisions ? { decisions } : {}),
  ...(scheduler ? { scheduler } : {}),
  dataDir,
  ...(process.env["OFFICE_VAULT_DIR"] ? { vaultDir: process.env["OFFICE_VAULT_DIR"] } : {}),
});

// Only now, with the port bound: a second instance that fails to bind must not touch the first one's workers.
// Stop leftover processes and list earlier workers as detached. Nothing restarts.
await supervisor.recover();
scheduler?.start();
const watcher = await startWatcher({
  root: projectsDir,
  registry,
  staleMs: staleMinutes * 60_000,
  isManaged: supervisor.claims,
  startPending: supervisor.starting,
});

console.log(`Workers may use these folders: ${roots.join(", ")}`);
// The only place the token is printed. It works once.
const stable = Boolean(process.env["OFFICE_SESSION_SECRET"]);
if (stable) console.log("Stable dev login is on: this link can be used again and logins survive restarts. For development only; unset OFFICE_SESSION_SECRET to get one-time links.");
console.log(
  `Open this ${stable ? "dev" : "one-time"} URL in your browser:\nhttp://127.0.0.1:${publicPort ?? app.port}/api/session?t=${app.token}`,
);

// Stop every worker before leaving, so no agent process is left running.
process.once("SIGINT", () => {
  // The scheduler stops first and waits for a tick in flight, so no sweep starts after the supervisor closes.
  void Promise.resolve(scheduler?.close())
    .then(() => supervisor.close())
    .then(() => Promise.all([app.close(), watcher.close()]))
    .then(() => process.exit(0));
});
