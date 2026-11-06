import { randomBytes } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UNSAFE } from "./findings.ts";
import { realOps, renameWithRetry } from "./managedStore.ts";

// Adding and removing skills in the owner's skills folder, from the sidebar. The owner confirms in the page first.
// Rules: a new skill never replaces an existing folder; only skills added here can be removed; removing moves the
// folder to a trash folder instead of deleting it. Nothing here runs anything.

export const SKILL_NAME = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]{0,59}$/; // not a Windows device name
export const MAX_SKILL_BYTES = 100 * 1024;
export const MAX_COPY_FILES = 50;
export const MAX_COPY_BYTES = 1024 * 1024;
const ADDED_FILE = "skills-added.json";
const SKIP = new Set([".git", "node_modules"]);

export type SkillsDirs = { skillsDir: string; trashDir: string; addedFile: string };
export type Failure = "invalid_name" | "invalid_skill" | "too_big" | "exists" | "not_found" | "not_added" | "source_missing" | "risky_header" | "failed";
export type Result = { ok: true } | { ok: false; code: Failure };

export const dirsFor = (skillsDir: string, dataDir: string): SkillsDirs => ({ skillsDir, trashDir: join(dataDir, "skills-trash"), addedFile: join(dataDir, ADDED_FILE) });

export async function readAdded(file: string): Promise<Set<string>> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    const names = typeof data === "object" && data !== null ? (data as { names?: unknown }).names : undefined;
    return new Set(Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && SKILL_NAME.test(n)) : []);
  } catch {
    return new Set();
  }
}

export async function writeAdded(file: string, names: Set<string>) {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, names: [...names].sort() }));
  // On Windows a rename can fail for a moment while a reader has the file open.
  await renameWithRetry(realOps, tmp, file);
}

/** The names of the skills that were added from the sidebar (only these can be removed there). */
export const addedSkills = (dirs: SkillsDirs) => readAdded(dirs.addedFile);

/** A SKILL.md must start with a header that has a name equal to the folder name and a one-line description. */
export function validSkillText(name: string, text: string): boolean {
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES || text.includes("\0")) return false;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end === -1) return false;
  const header = lines.slice(1, end);
  if (header.some((l) => UNSAFE.test(l))) return false;
  const value = (key: string) => header.map((l) => new RegExp(`^${key}:\\s*(.*)$`).exec(l)?.[1]?.trim()).find((v) => v !== undefined);
  const skillName = value("name")?.replace(/^["']|["']$/g, "");
  return skillName === name && Boolean(value("description")?.replace(/^["'>|-]+\s*/, "").trim());
}

type Counter = { files: number; bytes: number };

async function copyTree(from: string, to: string, counter: Counter): Promise<"ok" | "too_big"> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      counter.files++; // folders count too, so a tree of empty folders is bounded as well
      if (counter.files > MAX_COPY_FILES) return "too_big";
      if ((await copyTree(source, target, counter)) === "too_big") return "too_big";
    } else if (entry.isFile()) {
      counter.files++;
      counter.bytes += (await stat(source)).size;
      if (counter.files > MAX_COPY_FILES || counter.bytes > MAX_COPY_BYTES) return "too_big";
      await copyFile(source, target);
    }
  }
  return "ok";
}

/** Creates `<skillsDir>/<name>/` from pasted SKILL.md text, or from a folder that holds a SKILL.md. Never replaces anything. */
export async function addSkill(dirs: SkillsDirs, input: { name: string; content?: string; source?: string }): Promise<Result> {
  if (!SKILL_NAME.test(input.name)) return { ok: false, code: "invalid_name" };
  const target = join(dirs.skillsDir, input.name);
  try {
    await mkdir(dirs.skillsDir, { recursive: true });
    await mkdir(target); // fails if the name is taken: nothing is ever overwritten
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed" };
  }
  const undo = async (code: Failure): Promise<Result> => {
    await rm(target, { recursive: true, force: true });
    return { ok: false, code };
  };
  try {
    if (input.content !== undefined) {
      if (!validSkillText(input.name, input.content)) return await undo(Buffer.byteLength(input.content) > MAX_SKILL_BYTES ? "too_big" : "invalid_skill");
      await writeFile(join(target, "SKILL.md"), input.content, { flag: "wx" });
    } else if (input.source !== undefined) {
      let source: string;
      try {
        if (input.source.startsWith("\\\\") || input.source.startsWith("//")) return await undo("source_missing"); // network paths are not followed
        source = await realpath(input.source);
        if (!(await stat(source)).isDirectory()) return await undo("source_missing");
      } catch {
        return await undo("source_missing");
      }
      const file = join(source, "SKILL.md");
      if (!(await lstat(file).then((i) => i.isFile(), () => false))) return await undo("invalid_skill");
      if ((await copyTree(source, target, { files: 0, bytes: 0 })) === "too_big") return await undo("too_big");
      if (!validSkillText(input.name, await readFile(join(target, "SKILL.md"), "utf8"))) return await undo("invalid_skill");
    } else {
      return await undo("invalid_skill");
    }
    const added = await readAdded(dirs.addedFile);
    added.add(input.name);
    await writeAdded(dirs.addedFile, added);
    return { ok: true };
  } catch {
    return undo("failed");
  }
}

/** Moves a skill that was added from the sidebar into the trash folder. Everything else is refused. */
export async function removeSkill(dirs: SkillsDirs, name: string, now: () => number = Date.now): Promise<Result> {
  if (!SKILL_NAME.test(name)) return { ok: false, code: "invalid_name" };
  const added = await readAdded(dirs.addedFile);
  if (!added.has(name)) return { ok: false, code: "not_added" };
  const from = join(dirs.skillsDir, name);
  try {
    const info = await lstat(from);
    if (!info.isDirectory()) return { ok: false, code: "not_found" };
  } catch {
    return { ok: false, code: "not_found" };
  }
  try {
    await mkdir(dirs.trashDir, { recursive: true });
    const to = join(dirs.trashDir, `${name}-${now()}`);
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
      await rm(from, { recursive: true, force: true });
    }
    added.delete(name);
    await writeAdded(dirs.addedFile, added);
    return { ok: true };
  } catch {
    return { ok: false, code: "failed" };
  }
}
