import { lstat, readdir, readFile } from "node:fs/promises";
import { listOutcomes, oneLine } from "./planLog.ts";

// What the sweep Lead is told about our own work, so researchers look for improvements to what we use and what keeps
// going wrong. Names only: skill folder names, MCP server names and one line per recent run. All of it is capped,
// stripped of control characters and labelled as untrusted data.

export const DIGEST_MAX_CHARS = 2500;
const MAX_NAMES = 40;
const MAX_RUNS = 8;
const NAME = /^[\w][\w .:@-]{0,59}$/;
const MAX_CONFIG_BYTES = 5_000_000;

export type DigestSources = { plansLogDir?: string; skillsDir?: string; mcpFile?: string };

async function skillNames(dir: string | undefined): Promise<string[]> {
  if (!dir) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort().slice(0, MAX_NAMES);
  } catch {
    return [];
  }
}

/** Only the keys of the top-level "mcpServers" object; no values (they can hold tokens) are ever kept. */
async function mcpNames(file: string | undefined): Promise<string[]> {
  if (!file) return [];
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return [];
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    const servers = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["mcpServers"] : undefined;
    if (typeof servers !== "object" || servers === null) return [];
    return Object.keys(servers).filter((k) => NAME.test(k)).sort().slice(0, MAX_NAMES);
  } catch {
    return [];
  }
}

/** The block for the sweep prompt, or "" when there is nothing to tell. */
export async function buildDigest(src: DigestSources): Promise<string> {
  const [skills, servers, past] = await Promise.all([skillNames(src.skillsDir), mcpNames(src.mcpFile), listOutcomes(src.plansLogDir)]);
  const lines: string[] = [];
  if (skills.length > 0) lines.push(`Skills in use: ${skills.join(", ")}`);
  if (servers.length > 0) lines.push(`MCP servers in use: ${servers.join(", ")}`);
  const runs = past.outcomes.slice(0, MAX_RUNS);
  if (runs.length > 0) {
    const bad = runs.filter((o) => o.ended === "error" || o.ended === "cap").length;
    lines.push(`Recent runs (newest first; ${bad} of ${runs.length} ended in error or the usage cap):`);
    for (const o of runs) lines.push(`- ${oneLine(o.goal, 100)} | ${oneLine(o.project, 40)} | ${o.ended}`);
  }
  return [...lines.join("\n")].slice(0, DIGEST_MAX_CHARS).join("");
}
