import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UNSAFE_G } from "./findings.ts";

// What the owner has set up for Claude Code, for the sidebar: skill folders and user-level MCP servers.
// Read only. Nothing that can hold a secret is returned: no env values, no headers, no arguments, no URL paths or queries.

export const MAX_ITEMS = 200;
const NAME = /^[\w][\w .:@-]{0,59}$/;
const MAX_CONFIG_BYTES = 5_000_000;
const HEAD_BYTES = 4096;

export type Skill = { name: string; description: string; /** When SKILL.md last changed (ms since 1970); 0 when unknown. */ modified: number };
export type McpServer = { name: string; type: "stdio" | "http" | "sse"; command?: string; argCount?: number; host?: string; envCount: number; hasHeaders: boolean };

const oneLine = (text: string, max: number) => text.replace(UNSAFE_G, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The description line of a SKILL.md header; lenient, because skills in the wild write it in several ways. */
export function skillDescription(head: string): string {
  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  const end = lines.indexOf("---", 1);
  for (const line of lines.slice(1, end === -1 ? undefined : end)) {
    const m = /^description:\s*(.*)$/.exec(line);
    if (m) return oneLine((m[1] ?? "").replace(/^["'>|-]+\s*/, "").replace(/["']$/, ""), 200);
  }
  return "";
}

export async function listSkills(dir: string | undefined): Promise<Skill[]> {
  if (!dir) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_ITEMS);
  const skills: Skill[] = [];
  for (const name of names) {
    let description = "";
    let modified = 0;
    try {
      const file = join(dir, name, "SKILL.md");
      const info = await lstat(file);
      if (info.isFile()) {
        modified = Math.round(info.mtimeMs);
        const handle = await open(file, "r");
        try {
          const buffer = Buffer.alloc(HEAD_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
          description = skillDescription(buffer.subarray(0, bytesRead).toString("utf8"));
        } finally {
          await handle.close();
        }
      }
    } catch {
      // a folder without a readable SKILL.md is still listed, without a description
    }
    skills.push({ name, description, modified });
  }
  return skills;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The user-level servers in the Claude settings file. Only shapes and names leave this function. */
export async function listMcpServers(file: string | undefined): Promise<McpServer[]> {
  if (!file) return [];
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return [];
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    const servers = isRecord(data) ? data["mcpServers"] : undefined;
    if (!isRecord(servers)) return [];
    const out: McpServer[] = [];
    for (const name of Object.keys(servers).filter((k) => NAME.test(k)).sort((a, b) => a.localeCompare(b)).slice(0, MAX_ITEMS)) {
      const s = servers[name];
      if (!isRecord(s)) continue;
      const url = typeof s["url"] === "string" ? s["url"] : "";
      const type = s["type"] === "http" || s["type"] === "sse" ? s["type"] : url ? "http" : "stdio";
      const base: McpServer = {
        name,
        type,
        envCount: isRecord(s["env"]) ? Object.keys(s["env"]).length : 0,
        hasHeaders: isRecord(s["headers"]) && Object.keys(s["headers"]).length > 0,
      };
      if (type === "stdio") {
        out.push({ ...base, ...(typeof s["command"] === "string" ? { command: oneLine(s["command"], 120).split(" ")[0] ?? "" } : {}), argCount: Array.isArray(s["args"]) ? s["args"].length : 0 });
      } else {
        let host: string | undefined;
        try {
          host = new URL(url).host.slice(0, 100);
        } catch {
          host = undefined;
        }
        out.push({ ...base, ...(host ? { host } : {}) });
      }
    }
    return out;
  } catch {
    return [];
  }
}
