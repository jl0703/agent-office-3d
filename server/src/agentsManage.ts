import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UNSAFE } from "./findings.ts";
import { readAdded, SKILL_NAME, MAX_SKILL_BYTES, validSkillText, writeAdded, type Failure } from "./skillsManage.ts";

// Adding and removing the owner's Claude Code agents (`<agents folder>/<name>.md`), from the page, after the owner
// confirms. Same rules as skills: a new agent never replaces a file, only agents added here can be removed, and removing
// moves the file to a trash folder. Nothing here runs anything.

export const AGENT_NAME = SKILL_NAME;

// Header fields that give an agent more power than its description says: its own hooks (shell commands), a permission
// mode, or MCP servers. This page does not add such agents; the owner can put one in the folder by hand.
const RISKY_KEYS = new Set(["hooks", "permissionmode", "mcpservers"]);

/** True when the file's header has one of the fields above. */
export function hasRiskyHeader(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.indexOf("---", 1);
  return lines.slice(1, end === -1 ? undefined : end).some((l) => RISKY_KEYS.has((/^([A-Za-z_][\w-]*)\s*:/.exec(l)?.[1] ?? "").toLowerCase()));
}

export type AgentDirs = { agentsDir: string; trashDir: string; addedFile: string };
export type Result = { ok: true } | { ok: false; code: Failure };

export const agentDirsFor = (agentsDir: string, dataDir: string): AgentDirs => ({ agentsDir, trashDir: join(dataDir, "agents-trash"), addedFile: join(dataDir, "agents-added.json") });

export const addedAgents = (dirs: AgentDirs) => readAdded(dirs.addedFile);

/** Creates `<agentsDir>/<name>.md` from pasted text, or from a .md file. Never replaces anything. */
export async function addAgent(dirs: AgentDirs, input: { name: string; content?: string; source?: string }): Promise<Result> {
  if (!AGENT_NAME.test(input.name)) return { ok: false, code: "invalid_name" };
  let text: string;
  if (input.content !== undefined) {
    text = input.content;
  } else if (input.source !== undefined) {
    if (input.source.startsWith("\\\\") || input.source.startsWith("//")) return { ok: false, code: "source_missing" }; // network paths are not followed
    if (!input.source.toLowerCase().endsWith(".md")) return { ok: false, code: "source_missing" };
    try {
      const real = await realpath(input.source);
      const info = await stat(real);
      if (!info.isFile()) return { ok: false, code: "source_missing" };
      if (info.size > MAX_SKILL_BYTES) return { ok: false, code: "too_big" };
      text = await readFile(real, "utf8");
    } catch {
      return { ok: false, code: "source_missing" };
    }
  } else {
    return { ok: false, code: "invalid_skill" };
  }
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) return { ok: false, code: "too_big" };
  if (!validSkillText(input.name, text)) return { ok: false, code: "invalid_skill" };
  if (hasRiskyHeader(text)) return { ok: false, code: "risky_header" };
  const target = join(dirs.agentsDir, `${input.name}.md`);
  try {
    await mkdir(dirs.agentsDir, { recursive: true });
    await writeFile(target, text, { flag: "wx" }); // fails if the name is taken: nothing is ever overwritten
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed" };
  }
  try {
    const added = await readAdded(dirs.addedFile);
    added.add(input.name);
    await writeAdded(dirs.addedFile, added);
    return { ok: true };
  } catch {
    await rm(target, { force: true });
    return { ok: false, code: "failed" };
  }
}

/** Moves an agent that was added here into the trash folder. Everything else is refused. */
export async function removeAgent(dirs: AgentDirs, name: string, now: () => number = Date.now): Promise<Result> {
  if (!AGENT_NAME.test(name)) return { ok: false, code: "invalid_name" };
  const added = await readAdded(dirs.addedFile);
  if (!added.has(name)) return { ok: false, code: "not_added" };
  const from = join(dirs.agentsDir, `${name}.md`);
  try {
    if (!(await lstat(from)).isFile()) return { ok: false, code: "not_found" };
  } catch {
    return { ok: false, code: "not_found" };
  }
  try {
    await mkdir(dirs.trashDir, { recursive: true });
    const to = join(dirs.trashDir, `${name}-${now()}.md`);
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(from, to);
      await rm(from, { force: true });
    }
    added.delete(name);
    await writeAdded(dirs.addedFile, added);
    return { ok: true };
  } catch {
    return { ok: false, code: "failed" };
  }
}

/** The header lines of an agent file that the page shows: description, model and tools, each on one line. */
export function agentFacts(head: string): { description: string; model: string; tools: string } {
  const lines = head.split(/\r?\n/);
  const out = { description: "", model: "", tools: "" };
  if (lines[0]?.trim() !== "---") return out;
  const end = lines.indexOf("---", 1);
  for (const line of lines.slice(1, end === -1 ? undefined : end)) {
    const m = /^(description|model|tools):\s*(.*)$/.exec(line);
    const key = m?.[1] as keyof typeof out | undefined;
    if (key && m) out[key] = (m[2] ?? "").replace(UNSAFE_LINE, " ").replace(/\s+/g, " ").trim().slice(0, key === "description" ? 200 : 120);
  }
  return out;
}

const UNSAFE_LINE = new RegExp(UNSAFE.source, "gu");
