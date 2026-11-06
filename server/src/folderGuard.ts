import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

// A worker's file tools must stay inside its folder. Permission rules for file tools match
// every path, so this check runs before each tool call, in this process, and decides from
// the real path (links followed). Anything it cannot verify is denied.

export type Verdict = { ok: true } | { ok: false; reason: string };

const DENY = (reason: string): Verdict => ({ ok: false, reason });

/** Checks one tool call against the worker's folder. `root` must already be a real path. */
export async function checkToolCall(root: string, tool: string, input: unknown, extraTools: readonly string[] = []): Promise<Verdict> {
  if (tool === "WebSearch" || extraTools.includes(tool)) return { ok: true };
  if (!isRecord(input)) return DENY("tool input was not understood");

  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
      return checkPaths(root, [required(input["file_path"])]);
    case "Glob":
      return checkPaths(root, [optional(input["path"]), required(input["pattern"])]);
    case "Grep":
      // `pattern` is a search expression, not a path. `glob` and `path` are.
      return checkPaths(root, [optional(input["path"]), optional(input["glob"])]);
    default:
      return DENY("this tool is not available to workers");
  }
}

type Item = { value: string | null; missing: boolean };

const required = (value: unknown): Item =>
  typeof value === "string" && value.length > 0 ? { value, missing: false } : { value: null, missing: true };

// An optional path left out means the worker's folder.
const optional = (value: unknown): Item => (value === undefined ? { value: null, missing: false } : required(value));

async function checkPaths(root: string, items: Item[]): Promise<Verdict> {
  for (const item of items) {
    if (item.missing) return DENY("a path was missing or not text");
    if (item.value === null) continue;
    if (item.value.includes("\0")) return DENY("a path was not valid");
    // Anywhere in the text, not only as a whole segment: a brace pattern such as {..,x}/f can expand to a parent folder.
    if (item.value.includes("..")) return DENY("parent-folder references are not allowed");
    // File patterns take the same check: where they start decides what they can match.
    const verdict = await checkPath(root, item.value);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

async function checkPath(root: string, candidate: string): Promise<Verdict> {
  if (/^[\\/]{2}/.test(candidate) || candidate.startsWith("~")) return DENY("path is outside the worker's folder");
  const real = await realPathOfDeepestParent(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  return isInside(root, real) ? { ok: true } : DENY("path is outside the worker's folder");
}

/** The real path of a file that may not exist yet: resolve the nearest existing parent, then add the rest. */
async function realPathOfDeepestParent(path: string): Promise<string> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("no existing parent folder");
      rest.push(basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** An Evaluator may create its one report file and nothing else. */
async function checkSingleFile(root: string, tool: string, input: unknown, allowed: string): Promise<Verdict> {
  if (tool !== "Write") return DENY("this session may only create its one report file");
  const inside = await checkToolCall(root, tool, input);
  if (!inside.ok) return inside;
  const file = isRecord(input) ? input["file_path"] : undefined;
  if (typeof file !== "string") return DENY("a path was missing or not text");
  const real = await realPathOfDeepestParent(isAbsolute(file) ? file : resolve(root, file));
  if (normalize(real) !== normalize(allowed)) return DENY("this session may only create its one report file");
  return (await lstat(real).then(() => true, () => false)) ? DENY("the report file already exists") : { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The hook to give a session. `onFailure: "block"` makes a hook that errors block the call
 * instead of letting it through (the default would let it through).
 */
export function folderGuardHooks(
  root: string,
  onDeny: (tool: string, reason: string) => void = () => {},
  extraTools: readonly string[] = [],
  /** While true the session is read-only: Write and Edit are denied. */
  readOnly: () => boolean = () => false,
  /** When set, the only file the session may write: it must not exist yet, and Edit is refused. */
  writeOnly: string | null = null,
): NonNullable<Options["hooks"]> {
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let verdict: Verdict;
    try {
      verdict = readOnly() && (input.tool_name === "Write" || input.tool_name === "Edit")
        ? DENY("planning is read-only: submit a plan and wait for approval")
        : (input.tool_name === "Write" || input.tool_name === "Edit") && writeOnly !== null
          ? await checkSingleFile(root, input.tool_name, input.tool_input, writeOnly)
          : await checkToolCall(root, input.tool_name, input.tool_input, extraTools);
    } catch {
      verdict = DENY("the path could not be checked");
    }
    if (verdict.ok) return {};
    onDeny(input.tool_name, verdict.reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    };
  };
  return { PreToolUse: [{ hooks: [guard], onFailure: "block" }] };
}
