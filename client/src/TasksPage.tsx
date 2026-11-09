import { useEffect, useState } from "react";
import type { Agent } from "../../shared/events.ts";
import { demoFindings, getFindings, type Finding } from "./research.ts";
import { hrefFor } from "./route.ts";
import { COLUMNS, COLUMN_EMPTY, COLUMN_WORD, tasksOf, type Task } from "./tasks.ts";
import { demoBuilds, getBuilds, type Build } from "./workshop.ts";

const POLL_MS = 15_000;

/** The builds and findings, read when the page opens and every few seconds. A failed read keeps what is already shown. */
function useWork(demo: boolean) {
  const [work, setWork] = useState<{ builds: Build[]; findings: Finding[] }>({ builds: demo ? demoBuilds() : [], findings: demo ? demoFindings() : [] });
  useEffect(() => {
    if (demo) return setWork({ builds: demoBuilds(), findings: demoFindings() });
    setWork({ builds: [], findings: [] });
    let live = true;
    const load = async () => {
      const [b, f] = await Promise.all([getBuilds(), getFindings()]);
      if (!live) return;
      setWork((old) => ({ builds: b && b !== "off" ? b.builds : old.builds, findings: f ? f.findings : old.findings }));
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [demo]);
  return work;
}

function Card({ task, onOpenAgent }: { task: Task; onOpenAgent: (id: string) => void }) {
  const open = "agent" in task.target ? (
    <button type="button" className="link-btn" onClick={() => onOpenAgent((task.target as { agent: string }).agent)}>
      Open in the office
    </button>
  ) : (
    <a className="link-btn" href={hrefFor({ page: "find", id: task.target.find })}>
      Open the find
    </a>
  );
  return (
    <li className="task-card">
      <h3>{task.title}</h3>
      <p className="panel-note">{task.who}</p>
      {task.text && <p>{task.text}</p>}
      <div className="task-foot">
        <span className="chip">{task.chip}</span>
        {open}
      </div>
    </li>
  );
}

/** What the agents are doing, as a board with four columns. Read-only: it follows the work and cannot be edited by hand. */
export function TasksPage({ agents, demo, onOpenAgent }: { agents: readonly Agent[]; demo: boolean; onOpenAgent: (id: string) => void }) {
  const { builds, findings } = useWork(demo);
  const columns = tasksOf(agents, builds, findings);
  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <header className="catalog-head">
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            Tasks
          </h1>
          <p className="catalog-blurb">What the agents are doing. The board follows their work, so cards move by themselves.</p>
          {demo && <p className="panel-note">Demo mode: made-up work.</p>}
        </div>
      </header>
      <div className="board-cols">
        {COLUMNS.map((c) => (
          <section key={c} className="board-col" aria-labelledby={`col-${c}`}>
            <h2 id={`col-${c}`}>
              {COLUMN_WORD[c]} <span className="count">{columns[c].length}</span>
            </h2>
            {columns[c].length === 0 ? (
              <p className="panel-note">{COLUMN_EMPTY[c]}</p>
            ) : (
              <ul>
                {columns[c].map((t) => (
                  <Card key={t.id} task={t} onOpenAgent={onOpenAgent} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
