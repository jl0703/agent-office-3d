// The owner's skills and user-level MCP servers, as the sidebar shows them. Names and shapes only: the server never sends secrets.

/** `added` is true for skills added from the sidebar, the only ones it can remove. */
export type Skill = { name: string; description: string; added: boolean; modified: number };
export type McpServer = { name: string; type: "stdio" | "http" | "sse"; command?: string; argCount?: number; host?: string; envCount: number; hasHeaders: boolean; /** True for servers added from this app, the only ones it can remove. */ added: boolean };
export type Setup = { skills: Skill[]; mcp: McpServer[]; canManage: boolean; canManageMcp: boolean };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toSkill(raw: unknown): Skill | null {
  return isRecord(raw) && typeof raw["name"] === "string" && typeof raw["description"] === "string" ? { name: raw["name"], description: raw["description"], added: raw["added"] === true, modified: typeof raw["modified"] === "number" ? raw["modified"] : 0 } : null;
}

function toServer(raw: unknown): McpServer | null {
  if (!isRecord(raw) || typeof raw["name"] !== "string") return null;
  const type = raw["type"];
  if (type !== "stdio" && type !== "http" && type !== "sse") return null;
  return {
    name: raw["name"],
    type,
    envCount: typeof raw["envCount"] === "number" ? raw["envCount"] : 0,
    hasHeaders: raw["hasHeaders"] === true,
    added: raw["added"] === true,
    ...(typeof raw["command"] === "string" ? { command: raw["command"] } : {}),
    ...(typeof raw["argCount"] === "number" ? { argCount: raw["argCount"] } : {}),
    ...(typeof raw["host"] === "string" ? { host: raw["host"] } : {}),
  };
}

/** The lists; null when the server cannot be reached or answers oddly. */
export async function getSetup(fetchFn: FetchFn = fetch): Promise<Setup | null> {
  try {
    const res = await fetchFn("/api/setup");
    if (!res.ok) return null;
    const data = (await res.json()) as { skills?: unknown; mcp?: unknown; canManage?: unknown; canManageMcp?: unknown };
    if (!Array.isArray(data.skills) || !Array.isArray(data.mcp)) return null;
    return { skills: data.skills.map(toSkill).filter((s): s is Skill => s !== null), mcp: data.mcp.map(toServer).filter((s): s is McpServer => s !== null), canManage: data.canManage === true, canManageMcp: data.canManageMcp === true };
  } catch {
    return null;
  }
}

/** One line saying how a server is run, without anything secret. */
export function describeServer(s: McpServer): string {
  const where =
    s.type === "stdio"
      ? `runs ${s.command ?? "a command"}${s.argCount ? ` with ${s.argCount} argument${s.argCount === 1 ? "" : "s"}` : ""}`
      : `${s.type.toUpperCase()} to ${s.host ?? "a remote address"}`;
  const secrets = [s.envCount > 0 ? `${s.envCount} environment value${s.envCount === 1 ? "" : "s"} set` : "", s.hasHeaders ? "headers set" : ""].filter(Boolean).join(", ");
  return secrets ? `${where}; ${secrets}` : where;
}

export const matches = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());

export function demoSetup(): Setup {
  return {
    skills: [
      { name: "demo-clean-code", description: "Demo: pragmatic coding standards", added: false, modified: Date.UTC(2026, 9, 1) },
      { name: "demo-code-reviewer", description: "Demo: reviews a diff for bugs and style", added: false, modified: Date.UTC(2026, 9, 20) },
      { name: "demo-docs-writer", description: "Demo: writes short, accurate documentation", added: true, modified: Date.UTC(2026, 10, 5) },
    ],
    mcp: [
      { name: "demo-files", type: "stdio", command: "node", argCount: 2, envCount: 1, hasHeaders: false, added: false },
      { name: "demo-docs", type: "http", host: "mcp.example.com", envCount: 0, hasHeaders: true, added: true },
    ],
    canManage: true,
    canManageMcp: true,
  };
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

export type Changed = { ok: true } | { ok: false; message: string };

const FAILURES: Record<string, string> = {
  exists: "A skill with that name already exists. Nothing was changed.",
  invalid_name: "The name can only use lowercase letters, digits and hyphens (up to 60 characters).",
  invalid_skill: "The SKILL.md must start with a header (--- lines) that has name (the same as the skill name) and description.",
  too_big: "That is too big (SKILL.md up to 100 KB; a folder up to 50 files and 1 MB).",
  source_missing: "That folder could not be found.",
  not_added: "Only skills added from this menu can be removed here.",
  not_found: "That skill is no longer in the skills folder.",
};

async function change(path: string, body: unknown, fetchFn: FetchFn): Promise<Changed> {
  try {
    const res = await fetchFn(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(body as object), confirm: true }) });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
    const code = [data.error, data.reason].find((v) => typeof v === "string") as string | undefined;
    if (code && FAILURES[code]) return { ok: false, message: FAILURES[code] };
    if (res.status === 403) return { ok: false, message: "The session has expired. Open the link printed in the terminal again." };
    return { ok: false, message: `Something went wrong (error ${res.status}). Nothing was changed.` };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

/** Adds a skill from pasted SKILL.md text or from a folder path. The page asks the owner to confirm before calling this. */
export const addSkill = (input: { name: string; content: string } | { name: string; source: string }, fetchFn: FetchFn = fetch) => change("/api/setup/skills", input, fetchFn);

/** Moves a skill that was added here to the trash folder. */
export const removeSkill = (name: string, fetchFn: FetchFn = fetch) => change("/api/setup/skills/remove", { name }, fetchFn);

/** What the form sends for a new MCP server. The server checks everything again. */
export type McpInput = { name: string; transport: "stdio" | "http" | "sse"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: string[] };

const MCP_FAILURES: Record<string, string> = {
  exists: "A server with that name already exists. Nothing was changed.",
  invalid_input: "Check the fields: the name uses letters, digits, dots, hyphens; a local program needs a command; a remote server needs an https address (or http://localhost).",
  not_added: "Only servers added from this app can be removed here.",
  failed: "The claude command did not succeed. Nothing was recorded; check your Claude Code installation.",
};

async function mcpCall(path: string, body: unknown, fetchFn: FetchFn): Promise<{ ok: true; command?: string } | { ok: false; message: string }> {
  try {
    const res = await fetchFn(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { command?: unknown };
      return typeof data.command === "string" ? { ok: true, command: data.command } : { ok: true };
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
    const code = [data.error, data.reason].find((v) => typeof v === "string") as string | undefined;
    if (code && MCP_FAILURES[code]) return { ok: false, message: MCP_FAILURES[code] };
    if (res.status === 403) return { ok: false, message: "The session has expired. Open the link printed in the terminal again." };
    return { ok: false, message: `Something went wrong (error ${res.status}). Nothing was changed.` };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

/** The exact command the server would run, with secret values hidden. Runs nothing. */
export const previewMcp = (input: McpInput, fetchFn: FetchFn = fetch) => mcpCall("/api/setup/mcp/preview", input, fetchFn);

/** Adds the server. The page calls this only after the owner confirmed the preview. */
export const addMcp = (input: McpInput, fetchFn: FetchFn = fetch) => mcpCall("/api/setup/mcp", { ...input, confirm: true }, fetchFn);

export const removeMcp = (name: string, fetchFn: FetchFn = fetch) => mcpCall("/api/setup/mcp/remove", { name, confirm: true }, fetchFn);

/** Reads the form's text boxes: one argument per line, KEY=value per line, "Name: value" per line. Returns null for a malformed line. */
export function parseLines(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
}

export function parseEnv(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const at = line.indexOf("=");
    if (at < 1) return null;
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}
