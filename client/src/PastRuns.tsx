import { RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { briefAgain, demoOutcomes, ENDED_WORD, getOutcomes, projectsOf, type Outcome } from "./outcomes.ts";

/** What earlier masters planned and how it ended, from the vault's plans-log. Read-only; "Plan again" fills the start form. */
export function PastRuns({ demo, off, onPlanAgain }: { demo: boolean; off: string | null; onPlanAgain: (brief: string) => void }) {
  const id = useId();
  const [outcomes, setOutcomes] = useState<Outcome[] | "loading" | null>("loading");
  const [invalid, setInvalid] = useState(0);
  const [project, setProject] = useState("");

  useEffect(() => {
    if (demo) {
      setOutcomes(demoOutcomes());
      setInvalid(0);
      return;
    }
    let live = true;
    void getOutcomes().then((r) => {
      if (!live) return;
      setOutcomes(r ? r.outcomes : null);
      setInvalid(r?.invalid ?? 0);
    });
    return () => {
      live = false;
    };
  }, [demo]);

  if (outcomes === "loading") return null;
  if (outcomes === null) return <p className="panel-note">Past runs could not be read.</p>;
  if (outcomes.length === 0) return <p className="panel-note">No past runs yet. When a master ends, a short note about it appears here.</p>;
  const projects = projectsOf(outcomes);
  const shown = outcomes.filter((o) => !project || o.project === project);

  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Past runs ({shown.length})</h3>
      {projects.length > 1 && (
        <>
          <label htmlFor={`${id}-project`}>Project</label>
          <select id={`${id}-project`} value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </>
      )}
      {invalid > 0 && <p className="panel-note">{invalid} notes could not be read.</p>}
      <ul className="note-list past-runs">
        {shown.map((o) => (
          <li key={o.id}>
            <details>
              <summary>
                {o.goal} <span className="origin">{ENDED_WORD[o.ended]}</span>
              </summary>
              <p className="panel-note">
                {o.project} · {o.date} · {o.workers} worker{o.workers === 1 ? "" : "s"} · ${o.cost_usd.toFixed(2)}
              </p>
              {o.steps.length > 0 && (
                <ol>
                  {o.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {o.result && <p className="panel-note">{o.result}</p>}
              <button type="button" disabled={Boolean(off)} title={off ?? undefined} onClick={() => onPlanAgain(briefAgain(o))}>
                <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" /> Plan again like this
              </button>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
