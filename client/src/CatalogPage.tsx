import { ArrowRight, Bot, Boxes, ChevronRight, ExternalLink, Home, Puzzle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { hrefFor, KIND_WORD, type CatalogKind } from "./route.ts";
import { DECISION_WORD, demoFindings, getFindings, safeLink, VERDICT_WORD, type Finding, type Kind } from "./research.ts";
import { McpManager } from "./McpManager.tsx";
import { RemoveButton, SkillManager } from "./SkillManager.tsx";
import { demoSetup, describeServer, getSetup, matches, type Agent, type McpServer, type Setup, type Skill } from "./setup.ts";

const ICON = { skills: Puzzle, mcp: Boxes, agents: Bot } as const;
const BLURB: Record<CatalogKind, string> = {
  skills: "Skills that Claude Code loads from your skills folder. Add one, read its details, or remove the ones you added here.",
  mcp: "MCP servers that give Claude Code extra tools. Secret values are never shown.",
  agents: "Your Claude Code agents: reusable helpers with their own instructions.",
};

type Sort = "stars" | "name" | "recent";
const SORTS: { id: Sort; label: string }[] = [
  { id: "stars", label: "Stars" },
  { id: "name", label: "Name" },
  { id: "recent", label: "Recent" },
];

/** Which research findings belong on which page: skills and MCP servers by kind, and the repository finds on the agents page. */
const FIND_KINDS: Record<CatalogKind, Kind[]> = { skills: ["skill"], mcp: ["mcp"], agents: ["repo"] };

/** The research findings, read once when the page opens: undefined while loading, null when they cannot be read. */
function useFinds(demo: boolean) {
  const [finds, setFinds] = useState<Finding[] | null | undefined>(demo ? demoFindings() : undefined);
  useEffect(() => {
    if (demo) return setFinds(demoFindings());
    setFinds(undefined); // never show made-up finds as if they were real while the real ones load
    let live = true;
    void getFindings().then((r) => live && setFinds(r ? r.findings : null));
    return () => {
      live = false;
    };
  }, [demo]);
  return finds;
}

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

function Card({ title, by, badge, description, chips, href, external, children }: { title: string; by: string; badge?: string; description: string; chips: string[]; href?: string; /** The source of a research find: opens in a new tab. */ external?: string; children?: ReactNode }) {
  return (
    <article className="card" aria-label={title}>
      <header>
        <h3>{title}</h3>
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
        <span className="card-actions">{children}</span>
        {href && (
          <a href={href} className="card-open tip" aria-label={`View details for ${title}`} data-tip="View details">
            <ArrowRight size={20} strokeWidth={1.75} aria-hidden="true" />
          </a>
        )}
        {external && (
          <a href={external} className="card-open tip" target="_blank" rel="noopener noreferrer" aria-label={`Open ${title} in a new tab`} data-tip="Open the source">
            <ExternalLink size={20} strokeWidth={1.75} aria-hidden="true" />
          </a>
        )}
      </footer>
    </article>
  );
}

const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : "unknown");

/** A list page in the catalog layout: breadcrumb, title, count, sort and search, and a grid of cards. */
export function CatalogPage({ kind, demo }: { kind: CatalogKind; demo: boolean }) {
  const { setup, reload } = useSetup(demo);
  const finds = useFinds(demo);
  const [chosen, setSort] = useState<Sort>("name");
  const [query, setQuery] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const Icon = ICON[kind];
  const ready = typeof setup === "object" && setup !== null ? setup : null;
  // Stars only means something while finds exist; if they go away the lists fall back to name order and Name shows as pressed.
  const sort: Sort = chosen === "stars" && !(finds ?? []).some((f) => FIND_KINDS[kind].includes(f.kind) && f.status !== "reject") ? "name" : chosen;

  const skills = useMemo(() => {
    const list = (ready?.skills ?? []).filter((s) => matches(`${s.name} ${s.description}`, query));
    return [...list].sort((a, b) => (sort === "recent" ? b.modified - a.modified || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));
  }, [ready, sort, query]);
  const servers = useMemo(() => (ready?.mcp ?? []).filter((s) => matches(`${s.name} ${describeServer(s)}`, query)).sort((a, b) => a.name.localeCompare(b.name)), [ready, query]);
  const agents = useMemo(() => {
    const list = (ready?.agents ?? []).filter((a) => matches(`${a.name} ${a.description}`, query));
    return [...list].sort((a, b) => (sort === "recent" ? b.modified - a.modified || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));
  }, [ready, sort, query]);

  // Findings the owner has not rejected, by the chosen sort: Stars puts the most starred first.
  const found = useMemo(() => {
    const list = (finds ?? []).filter((f) => FIND_KINDS[kind].includes(f.kind) && f.status !== "reject" && matches(`${f.title} ${f.why} ${f.improves ?? ""}`, query));
    return [...list].sort((a, b) => (sort === "stars" ? (b.stars ?? -1) - (a.stars ?? -1) : sort === "recent" ? b.date.localeCompare(a.date) : 0) || a.title.localeCompare(b.title));
  }, [finds, kind, query, sort]);
  const foundTotal = (finds ?? []).filter((f) => FIND_KINDS[kind].includes(f.kind) && f.status !== "reject").length;
  const rejected = (finds ?? []).filter((f) => FIND_KINDS[kind].includes(f.kind) && f.status === "reject").length;

  const total = kind === "skills" ? ready?.skills.length : kind === "mcp" ? ready?.mcp.length : ready?.agents.length;
  const shown = kind === "skills" ? skills.length : kind === "mcp" ? servers.length : agents.length;

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <Breadcrumb kind={kind} />
      <header className="catalog-head">
        <span className="catalog-icon" aria-hidden="true">
          <Icon size={28} strokeWidth={1.75} />
        </span>
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            {KIND_WORD[kind]}
          </h1>
          <p className="catalog-blurb">{BLURB[kind]}</p>
          <p className="panel-note" role="status" aria-live="polite">
            {demo ? "Demo mode: made-up items. " : ""}
            {ready ? `${total} installed${finds === undefined ? "" : `, ${foundTotal} found by research`}${query ? `; ${shown + found.length} match` : ""}` : setup === null ? "Your setup could not be read." : "Loading…"}
          </p>
        </div>
      </header>

      {(
        <div className="catalog-tools">
          <div className="chips" role="group" aria-label="Sort by">
            {SORTS.filter((s) => (s.id === "stars" ? foundTotal > 0 : kind !== "mcp" || s.id === "name")).map((s) => (
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

      {kind === "skills" && ready && (
        <>
        <div className="section-row">
          <h2 className="catalog-section">Yours ({skills.length})</h2>
          {ready.canManage && <SkillManager demo={demo} off={false} onChanged={reload} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />}
        </div>
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
              {s.added && ready.canManage && <RemoveButton name={s.name} onAsk={setPendingRemove} disabled={false} />}
            </Card>
          ))}
          {skills.length === 0 && <p className="panel-note">{ready.skills.length === 0 ? "No skills found in your skills folder." : "No skill matches."}</p>}
        </div>
        </>
      )}

      {kind === "mcp" && ready && (
        <>
        <div className="section-row">
          <h2 className="catalog-section">Yours ({servers.length})</h2>
          {ready.canManageMcp && <McpManager demo={demo} onChanged={reload} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />}
        </div>
        <div className="catalog-grid">
          {servers.map((s: McpServer) => (
            <Card
              key={s.name}
              title={s.name}
              by={s.added ? "Added from this app" : "In your Claude settings"}
              {...(s.added ? { badge: "Added here" } : {})}
              description={describeServer(s)}
              chips={[s.type === "stdio" ? "Local program" : s.type.toUpperCase(), ...(s.envCount > 0 ? [`${s.envCount} env value${s.envCount === 1 ? "" : "s"} set`] : []), ...(s.hasHeaders ? ["Headers set"] : [])]}
              href={hrefFor({ page: "item", kind, name: s.name })}
            >
              {s.added && ready.canManageMcp && <RemoveButton name={s.name} onAsk={setPendingRemove} disabled={false} />}
            </Card>
          ))}
          {servers.length === 0 && <p className="panel-note">{ready.mcp.length === 0 ? "No user-level MCP servers found." : "No server matches."}</p>}
        </div>
        </>
      )}

      {kind === "agents" && ready && (
        <>
        <div className="section-row">
          <h2 className="catalog-section">Yours ({agents.length})</h2>
          {ready.canManageAgents && <SkillManager demo={demo} off={false} noun="agent" onChanged={reload} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />}
        </div>
        <div className="catalog-grid">
          {agents.map((a: Agent) => (
            <Card
              key={a.name}
              title={a.name}
              by={a.added ? "Added from this app" : "In your agents folder"}
              {...(a.added ? { badge: "Added here" } : {})}
              description={a.description}
              chips={[...(a.model ? [`Model ${a.model}`] : []), ...(a.tools ? [`Tools ${a.tools}`] : []), `Updated ${when(a.modified)}`]}
              href={hrefFor({ page: "item", kind, name: a.name })}
            >
              {a.added && ready.canManageAgents && <RemoveButton name={a.name} onAsk={setPendingRemove} disabled={false} />}
            </Card>
          ))}
          {agents.length === 0 && <p className="panel-note">{ready.agents.length === 0 ? "No agents found in your agents folder." : "No agent matches."}</p>}
        </div>
        </>
      )}

      {ready && (
        <>
          <h2 className="catalog-section">Found by research{finds ? ` (${found.length})` : ""}</h2>
          {finds === undefined && <p className="panel-note">Loading…</p>}
          {finds === null && <p className="panel-note">The research findings could not be read.</p>}
          {rejected > 0 && <p className="panel-note">{rejected} rejected {rejected === 1 ? "find is" : "finds are"} hidden here. They stay on the research board.</p>}
          <div className="catalog-grid">
            {found.map((f) => (
              <Card
                key={f.id}
                title={f.title}
                by={`Found by ${f.found_by} on ${f.date}`}
                badge={DECISION_WORD[f.status]}
                description={f.why}
                chips={[
                  ...(f.stars !== undefined ? [`★ ${f.stars.toLocaleString()}`] : []),
                  ...(f.forks !== undefined ? [`Forks ${f.forks.toLocaleString()}`] : []),
                  ...(f.language ? [f.language] : []),
                  ...(f.license ? [f.license] : []),
                  `Relevance ${f.relevance}/5`,
                  `Effort ${f.effort}`,
                  `Risk ${f.risk}`,
                  ...(f.fit ? [`Fit: ${VERDICT_WORD[f.fit.verdict]}`] : []),
                  ...(f.improves ? [`Improves ${f.improves}`] : []),
                ]}
                {...(safeLink(f.url) ? { external: f.url } : {})}
              />
            ))}
            {finds && found.length === 0 && <p className="panel-note">{foundTotal === 0 ? "The research team has not found any yet. Run a sweep from the Research department." : "No find matches."}</p>}
          </div>
        </>
      )}
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
  const agentItem = kind === "agents" ? ready?.agents.find((a) => a.name === name) : undefined;
  const found = skill ?? server ?? agentItem;

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <Breadcrumb kind={kind} name={name} />
      <header className="catalog-head">
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            {name}
          </h1>
          {!ready && (
            <p className="panel-note" role="status" aria-live="polite">
              {setup === null ? "Your setup could not be read." : "Loading…"}
            </p>
          )}
          {ready && !found && (
            <p className="panel-note" role="status" aria-live="polite">
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
              <RemoveButton name={skill.name} onAsk={setPendingRemove} disabled={false} />
              <SkillManager demo={demo} off={false} showAdd={false} onChanged={() => (reload(), onGone())} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />
            </>
          )}
        </section>
      )}
      {agentItem && (
        <section className="item-body" aria-label="Details">
          <p>{agentItem.description || "No description."}</p>
          <dl className="item-facts">
            <dt>Model</dt>
            <dd>{agentItem.model || "Not set (uses your default)"}</dd>
            <dt>Tools</dt>
            <dd>{agentItem.tools || "Not set (all tools)"}</dd>
            <dt>Where it lives</dt>
            <dd>{agentItem.added ? "In your agents folder, added from this app" : "In your agents folder"}</dd>
            <dt>Last changed</dt>
            <dd>{when(agentItem.modified)}</dd>
          </dl>
          {agentItem.added && ready?.canManageAgents && (
            <>
              <RemoveButton name={agentItem.name} onAsk={setPendingRemove} disabled={false} />
              <SkillManager demo={demo} off={false} noun="agent" showAdd={false} onChanged={() => (reload(), onGone())} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />
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
          {server.added && ready?.canManageMcp && (
            <>
              <RemoveButton name={server.name} onAsk={setPendingRemove} disabled={false} />
              <McpManager demo={demo} showAdd={false} onChanged={() => (reload(), onGone())} pendingRemove={pendingRemove} onAskRemove={setPendingRemove} />
            </>
          )}
        </section>
      )}
    </main>
  );
}
