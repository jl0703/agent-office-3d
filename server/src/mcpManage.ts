import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClaudeRunner } from "./claudeCli.ts";
import { UNSAFE } from "./findings.ts";
import { realOps, renameWithRetry } from "./managedStore.ts";

// Adding and removing user-level MCP servers with the official `claude mcp add|remove --scope user` commands, after the
// owner confirms in the page. The office never starts a server, never edits the Claude settings file itself, never
// passes anything through a shell, and only removes servers that it added.

export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const HEADER = /^[A-Za-z0-9-]{1,50}: \S.{0,499}$/;

export type McpInput = { name: string; transport: "stdio" | "http" | "sse"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: string[] };
export type Failure = "invalid_input" | "exists" | "not_added" | "failed";
export type Result = { ok: true } | { ok: false; code: Failure };

const clean = (text: string, max: number) => text.length >= 1 && text.length <= max && !UNSAFE.test(text);

function validUrl(url: string): boolean {
  if (!clean(url, 500) || url.startsWith("-")) return false;
  try {
    const u = new URL(url);
    if (u.username !== "" || u.password !== "") return false;
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** The words after `claude`, or null when the input is not acceptable. Each value is its own item: nothing is joined into a string. */
export function buildArgs(input: McpInput): string[] | null {
  if (!MCP_NAME.test(input.name)) return null;
  const base = ["mcp", "add", "--scope", "user", "--transport", input.transport, input.name];
  if (input.transport === "stdio") {
    const { command, args = [], env = {} } = input;
    if (input.url !== undefined || input.headers !== undefined) return null;
    if (command === undefined || !clean(command, 200) || command.startsWith("-")) return null;
    if (args.length > 20 || !args.every((a) => clean(a, 300))) return null;
    const pairs = Object.entries(env);
    if (pairs.length > 10 || !pairs.every(([k, v]) => ENV_KEY.test(k) && clean(v, 500))) return null;
    return [...base, ...pairs.flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--", command, ...args];
  }
  const { url, headers = [] } = input;
  if (input.command !== undefined || input.args !== undefined || input.env !== undefined) return null;
  if (url === undefined || !validUrl(url)) return null;
  if (headers.length > 5 || !headers.every((h) => HEADER.test(h) && !UNSAFE.test(h))) return null;
  return [...base, url, ...headers.flatMap((h) => ["-H", h])];
}

const show = (word: string) => (/[\s"]/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word);

/** The command exactly as it will run, with environment values and header values hidden. */
export function previewLine(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    const before = args[i - 1];
    if (before === "-e" && word.includes("=")) out.push(`${word.slice(0, word.indexOf("="))}=(hidden)`);
    else if (before === "-H" && word.includes(":")) out.push(show(`${word.slice(0, word.indexOf(":"))}: (hidden)`));
    else out.push(show(word));
  }
  return `claude ${out.join(" ")}`;
}

async function readAdded(file: string): Promise<Set<string>> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    const names = typeof data === "object" && data !== null ? (data as { names?: unknown }).names : undefined;
    return new Set(Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && MCP_NAME.test(n)) : []);
  } catch {
    return new Set();
  }
}

async function writeAdded(file: string, names: Set<string>) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, names: [...names].sort() }));
  // On Windows a rename can fail for a moment while a reader has the file open.
  await renameWithRetry(realOps, tmp, file);
}

export const addedServers = readAdded;

// Changes to the list of added servers run one after another, so two requests at once cannot lose a name.
let registryQueue: Promise<unknown> = Promise.resolve();
const remember = (file: string, change: (names: Set<string>) => void) => {
  const next = registryQueue.then(async () => {
    const names = await readAdded(file);
    change(names);
    await writeAdded(file, names);
  });
  registryQueue = next.catch(() => undefined);
  return next.catch(() => undefined);
};

export type McpDeps = { run: ClaudeRunner; addedFile: string; existing: () => Promise<string[]> };

export async function addServer(deps: McpDeps, input: McpInput): Promise<Result> {
  const args = buildArgs(input);
  if (!args) return { ok: false, code: "invalid_input" };
  if ((await deps.existing()).includes(input.name)) return { ok: false, code: "exists" };
  const ran = await deps.run(args);
  if (!ran.ok) return { ok: false, code: "failed" };
  await remember(deps.addedFile, (names) => names.add(input.name));
  return { ok: true };
}

export async function removeServer(deps: McpDeps, name: string): Promise<Result> {
  if (!MCP_NAME.test(name)) return { ok: false, code: "invalid_input" };
  if (!(await readAdded(deps.addedFile)).has(name)) return { ok: false, code: "not_added" };
  const ran = await deps.run(["mcp", "remove", "--scope", "user", name]);
  if (!ran.ok) return { ok: false, code: "failed" };
  await remember(deps.addedFile, (names) => names.delete(name));
  return { ok: true };
}
