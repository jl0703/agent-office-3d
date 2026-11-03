// All knowledge of Claude Code's transcript format lives in this file.
// The format is undocumented, so every access is defensive and nothing here throws.

export type Fact =
  | { kind: "title"; text: string }
  | { kind: "prompt"; text: string }
  | { kind: "tool_start"; id: string; name: string; summary: string }
  | { kind: "tool_end"; id: string }
  | { kind: "event" };

export type ParsedLine =
  | { ok: true; ts: number | null; cwd: string | null; facts: Fact[]; unknownType?: string }
  | { ok: false };

const MAX_TEXT = 200;
const MAX_NAME = 100;
const MAX_ID = 200;
const MAX_TYPE = 64;

// Types seen in real transcripts that carry nothing the list needs.
const IGNORED_TYPES = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "attachment",
  "queue-operation",
  "mode",
  "file-history-delta",
  "file-history-snapshot",
  "system",
  "tools-used",
  "permission-mode",
  "cost-state",
  "pr-link",
]);

export function parseLine(raw: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  return parseValue(value);
}

/** Same as parseLine for a message that is already an object, such as one from the SDK stream. */
export function parseValue(value: unknown): ParsedLine {
  if (!isRecord(value) || typeof value["type"] !== "string") return { ok: false };

  const type = value["type"];
  const stamp = typeof value["timestamp"] === "string" ? Date.parse(value["timestamp"]) : NaN;
  const out: ParsedLine = {
    ok: true,
    ts: Number.isNaN(stamp) ? null : stamp,
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : null,
    facts: [],
  };

  if (type === "ai-title") {
    const title = value["aiTitle"];
    if (typeof title === "string" && clean(title)) out.facts.push({ kind: "title", text: clean(title) });
  } else if (type === "last-prompt") {
    const prompt = value["lastPrompt"];
    if (typeof prompt === "string" && clean(prompt)) out.facts.push({ kind: "prompt", text: clean(prompt) });
  } else if (type === "assistant" || type === "user") {
    out.facts.push({ kind: "event" });
    for (const block of contentBlocks(value)) {
      if (block["type"] === "tool_use") pushToolStart(out.facts, block);
      else if (block["type"] === "tool_result") pushToolEnd(out.facts, block);
    }
  } else if (!IGNORED_TYPES.has(type)) {
    out.unknownType = clean(type).slice(0, MAX_TYPE); // a hostile log could carry a huge type name
  }
  return out;
}

function contentBlocks(line: Record<string, unknown>): Record<string, unknown>[] {
  const message = line["message"];
  const content = isRecord(message) ? message["content"] : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function pushToolStart(facts: Fact[], block: Record<string, unknown>) {
  const { id, name } = block;
  if (typeof id !== "string" || typeof name !== "string") return;
  if (!id || id.length > MAX_ID || !name || name.length > MAX_NAME) return;
  facts.push({ kind: "tool_start", id, name, summary: describeToolUse(name, block["input"]) });
}

function pushToolEnd(facts: Fact[], block: Record<string, unknown>) {
  const id = block["tool_use_id"];
  if (typeof id === "string" && id && id.length <= MAX_ID) facts.push({ kind: "tool_end", id });
}

// Only a file name, host, or the tool's own description is shown. Shell command text,
// tool arguments, and outputs can hold secrets, so they are never copied.
function describeToolUse(name: string, input: unknown): string {
  if (!isRecord(input)) return name;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = input[key];
    if (typeof v === "string" && baseName(v)) return clean(`${name} ${baseName(v)}`);
  }
  const url = input["url"];
  if (typeof url === "string") {
    const where = hostAndPath(url);
    if (where) return clean(`${name} ${where}`);
  }
  for (const key of ["description", "pattern", "query", "skill", "subagent_type"]) {
    const v = input[key];
    if (typeof v === "string" && clean(v)) return clean(`${name} ${v}`);
  }
  return name;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function hostAndPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.pathname === "/" ? url.host : url.host + url.pathname;
  } catch {
    return null;
  }
}

/** Collapses whitespace and cuts to 200 characters. */
export function clean(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TEXT) return flat;
  let cut = flat.slice(0, MAX_TEXT - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // half of a surrogate pair
  return cut + "…";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
