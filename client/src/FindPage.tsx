import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BriefPanel, Stepper } from "./BriefPanel.tsx";
import { Breadcrumb, pageForFind } from "./CatalogPage.tsx";
import { nextStep, stagesOf } from "./pipeline.ts";
import { DECISIONS, DECISION_WORD, demoFindings, evaluateFinding, generateBrief, getFindings, KIND_WORD as FIND_KIND_WORD, safeLink, setDecision, VERDICT_WORD, type Decision, type Finding } from "./research.ts";
import { hrefFor } from "./route.ts";
import { getBuilds, startBuild, type Build } from "./workshop.ts";

/** One research find on its own page: the facts, the fit check, and what you can do with it. */
export function FindPage({ id, demo }: { id: string; demo: boolean }) {
  // undefined while loading, null when the findings cannot be read
  const [finds, setFinds] = useState<Finding[] | null | undefined>(demo ? demoFindings() : undefined);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (poll = false) => {
    if (demo) return;
    const got = await getFindings();
    // A failed look-again must not blank the page (and the brief editor on it): keep what is shown.
    if (got || !poll) setFinds(got ? got.findings : null);
    const made = await getBuilds();
    if (Array.isArray(made)) setBuilds(made);
  }, [demo]);
  useEffect(() => {
    if (demo) return setFinds(demoFindings());
    setFinds(undefined);
    void load();
    // A fit check, brief or build takes a minute: look again while the page is open.
    const timer = setInterval(() => void load(true), 15_000);
    return () => clearInterval(timer);
  }, [demo, load]);

  const f = finds?.find((x) => x.id === id);
  // The tab title names the find (the app leaves it to this page).
  const title = f?.title;
  useEffect(() => {
    document.title = `${title ?? "Research find"} - Agent Office`;
  }, [title]);
  const kindPage = f ? pageForFind(f.kind) : null;

  const decide = async (status: Decision) => {
    if (!f) return;
    if (demo) {
      setFinds((list) => list?.map((x) => (x.id === id ? { ...x, status } : x)));
      return setMessage("Demo mode: nothing was saved.");
    }
    setBusy(true);
    const result = await setDecision(id, status, f.note);
    setBusy(false);
    setMessage(result.ok ? `Marked ${DECISION_WORD[status]}.` : result.message);
    await load();
  };

  const checkFit = async () => {
    if (demo) return setMessage("Demo mode: no fit check is run.");
    setBusy(true);
    const result = await evaluateFinding(id);
    setBusy(false);
    setMessage(result.ok ? "Fit check started. The report appears here when it is written." : result.message);
  };

  const writeBrief = async () => {
    if (demo) return setMessage("Demo mode: no brief is written.");
    setBusy(true);
    const result = await generateBrief(id);
    setBusy(false);
    setMessage(result.ok ? "A Briefer is writing the brief. It appears here when it is written." : result.message);
  };

  const build = async () => {
    if (demo) return setMessage("Demo mode: nothing is built.");
    setBusy(true);
    const result = await startBuild(id);
    setBusy(false);
    setMessage(result.ok ? "Build started. The master asks for your approval of its plan first. See the Workshop." : result.message);
  };

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <Breadcrumb {...(kindPage ? { kind: kindPage } : {})} name={f?.title ?? "Research find"} />
      <header className="catalog-head">
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            {f?.title ?? "Research find"}
          </h1>
          {finds === undefined && (
            <p className="panel-note" role="status" aria-live="polite">
              Loading…
            </p>
          )}
          {finds === null && (
            <p className="panel-note" role="status" aria-live="polite">
              The research findings could not be read.
            </p>
          )}
          {finds && !f && (
            <p className="panel-note" role="status" aria-live="polite">
              That find is no longer in the research folder. <a href={hrefFor({ page: "list", kind: "skills" })}>Back to Skills</a>
            </p>
          )}
        </div>
      </header>

      {f && (
        <>
          <Stepper stages={stagesOf(f, builds)} />
          <p className="panel-note">Next: {nextStep(f, builds)}</p>
          <section className="item-body" aria-label="About this find">
            <p>{f.why}</p>
            <dl className="item-facts">
              <dt>Kind</dt>
              <dd>{FIND_KIND_WORD[f.kind]}</dd>
              <dt>Found by</dt>
              <dd>
                {f.found_by} on {f.date}
              </dd>
              {f.stars !== undefined && (
                <>
                  <dt>Stars</dt>
                  <dd>{f.stars.toLocaleString()}</dd>
                </>
              )}
              {f.forks !== undefined && (
                <>
                  <dt>Forks</dt>
                  <dd>{f.forks.toLocaleString()}</dd>
                </>
              )}
              {f.language && (
                <>
                  <dt>Language</dt>
                  <dd>{f.language}</dd>
                </>
              )}
              {f.license && (
                <>
                  <dt>Licence</dt>
                  <dd>{f.license}</dd>
                </>
              )}
              <dt>Relevance</dt>
              <dd>{f.relevance} of 5</dd>
              <dt>Effort and risk</dt>
              <dd>
                Effort {f.effort}, risk {f.risk}
              </dd>
              {f.improves && (
                <>
                  <dt>Improves</dt>
                  <dd>{f.improves}</dd>
                </>
              )}
              {f.note && (
                <>
                  <dt>Your note</dt>
                  <dd>{f.note}</dd>
                </>
              )}
            </dl>
          </section>

          {f.fit ? (
            <section className={`item-body fit-block fit-${f.fit.verdict}`} aria-label="Fit check">
              <h2 className="catalog-section">Fit check: {VERDICT_WORD[f.fit.verdict]}</h2>
              <dl className="item-facts">
                <dt>How it plugs in</dt>
                <dd>{f.fit.how}</dd>
                <dt>Clashes</dt>
                <dd>{f.fit.conflicts}</dd>
                <dt>Security</dt>
                <dd>{f.fit.security}</dd>
                <dt>Effort</dt>
                <dd>{f.fit.effort}</dd>
                <dt>Undo</dt>
                <dd>{f.fit.rollback}</dd>
                <dt>Checked</dt>
                <dd>{f.fit.date}</dd>
              </dl>
            </section>
          ) : (
            <p className="panel-note">No fit check yet. Mark it Looking, then press Check fit.</p>
          )}

          <BriefPanel f={f} demo={demo} onSaved={() => void load()} />

          <section className="item-body" aria-label="Actions">
            <h2 className="catalog-section">What to do with it</h2>
            <div className="chips" role="group" aria-label="Your decision">
              {DECISIONS.map((d) => (
                <button key={d} type="button" className="chip-filter" aria-pressed={f.status === d} disabled={busy} onClick={() => void decide(d)}>
                  {DECISION_WORD[d]}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              {f.status === "looking" && !f.fit && (
                <button type="button" disabled={busy} onClick={() => void checkFit()}>
                  Check fit
                </button>
              )}
              {f.status === "adopt" && !f.brief && (
                <button type="button" disabled={busy} onClick={() => void writeBrief()}>
                  Write the brief
                </button>
              )}
              {f.status === "adopt" && (
                <button type="button" disabled={busy} onClick={() => void build()}>
                  Build in the Workshop
                </button>
              )}
              {safeLink(f.url) && (
                <a className="link-button" href={f.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" /> Open on GitHub or the source
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </div>
            <p role="status" aria-live="polite" className="form-message">
              {message}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
