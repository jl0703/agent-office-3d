// The page the address bar names. The 3D office is "#/" (or no hash); the catalog pages are "#/skills", "#/mcp" and "#/agents",
// and one item is "#/skills/<name>". Anything else falls back to the office, so a mistyped address never shows a blank page.

export const KINDS = ["skills", "mcp", "agents"] as const;
export type CatalogKind = (typeof KINDS)[number];
export type Route = { page: "office" } | { page: "list"; kind: CatalogKind } | { page: "item"; kind: CatalogKind; name: string } | { page: "find"; id: string } | { page: "settings" } | { page: "tasks" } | { page: "team" };

const ITEM_NAME = /^[\w][\w .:@-]{0,59}$/;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  // One research find: "#/finds/<id>", with the same id rules as a finding's file name.
  if (parts[0] === "finds") return parts.length === 2 && /^[a-z0-9][a-z0-9-]{0,79}$/.test(parts[1] ?? "") ? { page: "find", id: parts[1] as string } : { page: "office" };
  if (parts[0] === "settings" || parts[0] === "tasks" || parts[0] === "team") return parts.length === 1 ? { page: parts[0] } : { page: "office" };
  const kind = KINDS.find((k) => k === parts[0]);
  if (!kind || parts.length > 2) return { page: "office" };
  if (parts.length === 1) return { page: "list", kind };
  let name: string;
  try {
    name = decodeURIComponent(parts[1] ?? "");
  } catch {
    return { page: "office" };
  }
  return ITEM_NAME.test(name) ? { page: "item", kind, name } : { page: "office" };
}

export const hrefFor = (route: Route) =>
  route.page === "office" ? "#/" : route.page === "settings" || route.page === "tasks" || route.page === "team" ? `#/${route.page}` : route.page === "list" ? `#/${route.kind}` : route.page === "find" ? `#/finds/${route.id}` : `#/${route.kind}/${encodeURIComponent(route.name)}`;

export const KIND_WORD: Record<CatalogKind, string> = { skills: "Skills", mcp: "MCP servers", agents: "AI Agents" };
