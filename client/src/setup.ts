// The owner's skills and user-level MCP servers, as the sidebar shows them. Names and shapes only: the server never sends secrets.

export type Skill = { name: string; description: string };
export type McpServer = { name: string; type: "stdio" | "http" | "sse"; command?: string; argCount?: number; host?: string; envCount: number; hasHeaders: boolean };
export type Setup = { skills: Skill[]; mcp: McpServer[] };

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toSkill(raw: unknown): Skill | null {
  return isRecord(raw) && typeof raw["name"] === "string" && typeof raw["description"] === "string" ? { name: raw["name"], description: raw["description"] } : null;
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
    const data = (await res.json()) as { skills?: unknown; mcp?: unknown };
    if (!Array.isArray(data.skills) || !Array.isArray(data.mcp)) return null;
    return { skills: data.skills.map(toSkill).filter((s): s is Skill => s !== null), mcp: data.mcp.map(toServer).filter((s): s is McpServer => s !== null) };
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
      { name: "demo-clean-code", description: "Demo: pragmatic coding standards" },
      { name: "demo-code-reviewer", description: "Demo: reviews a diff for bugs and style" },
      { name: "demo-docs-writer", description: "Demo: writes short, accurate documentation" },
    ],
    mcp: [
      { name: "demo-files", type: "stdio", command: "node", argCount: 2, envCount: 1, hasHeaders: false },
      { name: "demo-docs", type: "http", host: "mcp.example.com", envCount: 0, hasHeaders: true },
    ],
  };
}
