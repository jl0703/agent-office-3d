import { Bot, Boxes, Building2, ListChecks, Puzzle, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { pageForFind } from "./CatalogPage.tsx";
import { demoFindings, getFindings } from "./research.ts";
import { hrefFor, KIND_WORD, type CatalogKind, type Route } from "./route.ts";

const ICONS = { skills: Puzzle, mcp: Boxes, agents: Bot } as const;
const SHORT: Record<CatalogKind, string> = { skills: "Skills", mcp: "MCP", agents: "Agents" };
type Entry = { label: string; title: string; route: Route; icon: typeof Puzzle };
const ENTRIES: Entry[] = [
  { label: "Office", title: "Office", route: { page: "office" }, icon: Building2 },
  ...(["skills", "mcp", "agents"] as CatalogKind[]).map((kind) => ({ label: SHORT[kind], title: KIND_WORD[kind], route: { page: "list", kind } as Route, icon: ICONS[kind] })),
];
const TASKS: Entry = { label: "Tasks", title: "Tasks", route: { page: "tasks" }, icon: ListChecks };
const SETTINGS: Entry = { label: "Settings", title: "Settings", route: { page: "settings" }, icon: Settings };

const kindOf = (r: Route) => (r.page === "list" || r.page === "item" ? r.kind : null);
const same = (a: Route, b: Route) => (a.page === "office" || b.page === "office" || a.page === "settings" || b.page === "settings" || a.page === "tasks" || b.page === "tasks" ? a.page === b.page : kindOf(a) !== null && kindOf(a) === kindOf(b));

/** The rail down the left side (a bar along the bottom on a phone). Each entry is a link to its own page. */
export function Sidebar({ route: current, demo }: { route: Route; demo: boolean }) {
  const [findKind, setFindKind] = useState<CatalogKind | null>(null);
  const findId = current.page === "find" ? current.id : null;
  useEffect(() => {
    setFindKind(null);
    if (!findId) return;
    let live = true;
    void (demo ? Promise.resolve({ findings: demoFindings() }) : getFindings()).then((r) => {
      const f = r?.findings.find((x) => x.id === findId);
      if (live && f) setFindKind(pageForFind(f.kind));
    });
    return () => {
      live = false;
    };
  }, [findId, demo]);
  // A find belongs to the page that lists it, so that entry stays marked.
  const route: Route = current.page === "find" ? (findKind ? { page: "list", kind: findKind } : current) : current;

  const link = ({ label, title, route: target, icon: Icon }: Entry) => (
    <li key={label} className={target.page === "settings" ? "rail-end" : undefined}>
      <a href={hrefFor(target)} aria-current={same(route, target) ? "page" : undefined} aria-label={title}>
        <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
        <span>{label}</span>
      </a>
    </li>
  );

  return (
    <nav className="rail" aria-label="Pages">
      <ul>{[...ENTRIES, TASKS, SETTINGS].map(link)}</ul>
    </nav>
  );
}
