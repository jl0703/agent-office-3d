import { Bot, Boxes, ChevronRight, Home, Puzzle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { hrefFor, KIND_WORD, type CatalogKind } from "./route.ts";
import { RemoveButton, SkillManager } from "./SkillManager.tsx";
import { demoSetup, describeServer, getSetup, matches, type McpServer, type Setup, type Skill } from "./setup.ts";

const ICON = { skills: Puzzle, mcp: Boxes, agents: Bot } as const;
const BLURB: Record<CatalogKind, string> = {
  skills: "Skills that Claude Code loads from your skills folder. Add one, read its details, or remove the ones you added here.",
  mcp: "MCP servers that give Claude Code extra tools. Secret values are never shown.",
  agents: "Your Claude Code agents: reusable helpers with their own instructions.",
};

type Sort = "name" | "recent";
const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "recent", label: "Recent" },
];

/** The setup lists, loaded once the page opens and again when asked. A failed refresh keeps what is already shown. */
function useSetup(demo: boolean) {
  const [setup, setSetup] = useState<Setup | "loading" | null>("loading");
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (demo) return setSetup(demoSetup());
    let live = true;
    void getSetup().then((s) => live && setSetup((now) => (s === null && typeof now === "object" && now !== null ? now : s)));
    return () => {
      live = false;
    };
  }, [demo, reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  return { setup, reload };
}

function Breadcrumb({ kind, name }: { kind?: CatalogKind; name?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        <li>
          <a href={hrefFor({ page: "office" })}>
            <Home size={16} strokeWidth={1.75} aria-hidden="true" /> Office
          </a>
        </li>
        {kind && (
          <li>
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
            {name ? <a href={hrefFor({ page: "list", kind })}>{KIND_WORD[kind]}</a> : <span aria-current="page">{KIND_WORD[kind]}</span>}
          </li>
        )}
        {kind && name && (
          <li>
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
            <span aria-current="page">{name}</span>
          </li>
        )}
      </ol>
    </nav>
  );
}

function Card({ title, by, badge, description, chips, href, children }: { title: string; by: string; badge?: string; description: string; chips: string[]; href: string; children?: ReactNode }) {
  return (
    <article className="card" aria-label={title}>
      <header>
        <h2>{title}</h2>
        {badge && <span className="badge">{badge}</span>}
      </header>
      <p className="card-by">{by}</p>
      <p className="card-desc">{description || "No description."}</p>
      <ul className="card-chips" aria-label="Details">
        {chips.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <footer>
        <a href={href} aria-label={`View details for ${title}`}>
          View details
        </a>
        {children}
      </footer>
    </article>
  );
}

const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : "unknown");

/** A list page in the catalog layout: breadcrumb, title, count, sort and search, and a grid of cards. */
export function CatalogPage({ kind, demo }: { kind: CatalogKind; demo: boolean }) {
  const { setup, reload } = useSetup(demo);
  const [sort, setSort] = useState<Sort>("name");
  const [query, setQuery] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const Icon = ICON[kind];
  const ready = typeof setup === "object" && setup !== null ? setup : null;

  const skills = useMemo(() => {
    const list = (ready?.skills ?? []).filter((s) => matches(`${s.name} ${s.description}`, query));
    return [...list].sort((a, b) => (sort === "recent" ? b.modified - a.modified || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));
  }, [ready, sort, query]);
  const servers = useMemo(() => (ready?.mcp ?? []).filter((s) => matches(`${s.name} ${describeServer(s)}`, query)).sort((a, b) => a.name.localeCompare(b.name)), [ready, query]);

  const total = kind === "skills" ? ready?.skills.length : kind === "mcp" ? ready?.mcp.length : 0;
  const shown = kind === "skills" ? skills.length : kind === "mcp" ? servers.length : 0;

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <Breadcrumb kind={kind} />
      <header className="catalog-head">
        <span className="catalog-icon" aria-hidden="true">
          <Icon size={28} strokeWidth={1.75} />
        </span>
        <div>
          <h1 id="catalog-title">{KIND_WORD[kind]}</h1>
          <p className="catalog-blurb">{BLURB[kind]}</p>
          <p className="panel-note" role="status" aria-live="polite">
            {demo ? "Demo mode: made-up items. " : ""}
            {ready ? `${total} installed${query ? `, ${shown} match` : ""}` : setup === null ? "Your setup could not be read." : "Loading…"}
          </p>
        </div>
      </header>

      {kind !== "agents" && (
        <div className="catalog-tools">
          <div className="chips" role="group" aria-label="Sort by">
            {SORTS.filter((s) => kind === "skills" || s.id === "name").map((s) => (
              <button key={s.id} type="button" className="chip-filter" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <label className="catalog-search">
            <span className="sr-only">Search {KIND_WORD[kind]}</span>
            <input type="search" value={query} maxLength={60} placeholder={`Search ${KIND_WORD[kind].toLowerCase()}`} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
      )}

      {kind === "skills" && ready?.canManage && <SkillManager demo={demo} off={false} onChanged={reload} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />}

      {kind === "skills" && ready && (
        <div className="catalog-grid">
          {skills.map((s: Skill) => (
            <Card
              key={s.name}
              title={s.name}
              by={s.added ? "Added from this app" : "In your skills folder"}
              {...(s.added ? { badge: "Added here" } : {})}
              description={s.description}
              chips={[`Updated ${when(s.modified)}`]}
              href={hrefFor({ page: "item", kind, name: s.name })}
            >
              {s.added && ready.canManage && <RemoveButton name={s.name} onAsk={setPendingRemove} disabled={pendingRemove !== null} />}
            </Card>
          ))}
          {skills.length === 0 && <p className="panel-note">{ready.skills.length === 0 ? "No skills found in your skills folder." : "No skill matches."}</p>}
        </div>
      )}

      {kind === "mcp" && ready && (
        <div className="catalog-grid">
          {servers.map((s: McpServer) => (
            <Card key={s.name} title={s.name} by="In your Claude settings" description={describeServer(s)} chips={[s.type === "stdio" ? "Local program" : s.type.toUpperCase(), ...(s.envCount > 0 ? [`${s.envCount} env value${s.envCount === 1 ? "" : "s"} set`] : []), ...(s.hasHeaders ? ["Headers set"] : [])]} href={hrefFor({ page: "item", kind, name: s.name })} />
          ))}
          {servers.length === 0 && <p className="panel-note">{ready.mcp.length === 0 ? "No user-level MCP servers found." : "No server matches."}</p>}
        </div>
      )}

      {kind === "agents" && <p className="panel-note">Your agents will be listed here. This page arrives in the next update.</p>}
    </main>
  );
}

/** One skill or server on its own page: its description and, for a skill added here, the remove action. */
export function ItemPage({ kind, name, demo, onGone }: { kind: CatalogKind; name: string; demo: boolean; onGone: () => void }) {
  const { setup, reload } = useSetup(demo);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const ready = typeof setup === "object" && setup !== null ? setup : null;
  const skill = kind === "skills" ? ready?.skills.find((s) => s.name === name) : undefined;
  const server = kind === "mcp" ? ready?.mcp.find((s) => s.name === name) : undefined;
  const found = skill ?? server;

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <Breadcrumb kind={kind} name={name} />
      <header className="catalog-head">
        <div>
          <h1 id="catalog-title">{name}</h1>
          {!ready && <p className="panel-note">{setup === null ? "Your setup could not be read." : "Loading…"}</p>}
          {ready && !found && (
            <p className="panel-note">
              That item is no longer in your setup. <a href={hrefFor({ page: "list", kind })}>Back to {KIND_WORD[kind]}</a>
            </p>
          )}
        </div>
      </header>
      {skill && (
        <section className="item-body" aria-label="Details">
          <p>{skill.description || "No description."}</p>
          <dl className="item-facts">
            <dt>Where it lives</dt>
            <dd>{skill.added ? "In your skills folder, added from this app" : "In your skills folder"}</dd>
            <dt>Last changed</dt>
            <dd>{when(skill.modified)}</dd>
          </dl>
          {skill.added && ready?.canManage && (
            <>
              <RemoveButton name={skill.name} onAsk={setPendingRemove} disabled={pendingRemove !== null} />
              <SkillManager demo={demo} off={false} showAdd={false} onChanged={() => (reload(), onGone())} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />
            </>
          )}
        </section>
      )}
      {server && (
        <section className="item-body" aria-label="Details">
          <p>{describeServer(server)}</p>
          <dl className="item-facts">
            <dt>Kind</dt>
            <dd>{server.type === "stdio" ? "A local program" : `A remote ${server.type.toUpperCase()} server`}</dd>
            <dt>Where it lives</dt>
            <dd>In your Claude settings (user level)</dd>
          </dl>
          <p className="panel-note">Secret values and headers are never shown here.</p>
        </section>
      )}
    </main>
  );
}
