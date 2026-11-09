import { FlaskConical } from "lucide-react";
import { useId, useState } from "react";
import { Modal } from "./Modal.tsx";
import { getEval, percent, reviseBuild, startEval, VERDICT_WORD, type Build, type EvalFull, type EvalSide } from "./workshop.ts";

const sideText = (s: EvalSide) => ("error" in s ? s.error : `${s.passed} of ${s.total} checks`);

/** The skill eval of one build: run it (after a cost question), watch it, and read what it found. */
export function EvalPanel({ build, demo, onChanged }: { build: Build; demo: boolean; onChanged: () => void }) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [full, setFull] = useState<EvalFull | "loading" | null>(null);

  const run = async () => {
    if (demo) {
      setAsking(false);
      return setMessage("Demo mode: no eval is run.");
    }
    setBusy(true);
    setError("");
    const result = await startEval(build.id);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setAsking(false);
    setMessage("Eval started. The result appears here in a few minutes.");
    onChanged();
  };

  const revise = async () => {
    if (demo) {
      setRevising(false);
      return setMessage("Demo mode: no revision is started.");
    }
    setBusy(true);
    setError("");
    const result = await reviseBuild(build.id);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setRevising(false);
    setMessage("A new master is planning the next round. Its plan waits for your approval (see Needs you).");
    onChanged();
  };

  const showDetails = async () => {
    setFull("loading");
    setFull(demo ? demoFull(build) : await getEval(build.id));
  };

  const summary = build.eval;
  return (
    <section className="eval-panel" aria-label="Skill eval">
      <h3>Skill eval{(build.round ?? 1) > 1 ? `, round ${build.round} of 3` : ""}</h3>
      {build.evalRun?.failed && (
        <p className="form-message" role="alert">
          The last eval run failed before it finished. Nothing was saved. You can run it again.
        </p>
      )}
      {build.evalRun && !build.evalRun.failed && (
        <p className="panel-note" role="status" aria-live="polite">
          Eval running: {build.evalRun.done} of {build.evalRun.total} test requests done. This takes a few minutes.
        </p>
      )}
      {summary && !(build.evalRun && !build.evalRun.failed) && (
        <>
          <p className={`verdict verdict-${summary.verdict}`}>
            <strong>{VERDICT_WORD[summary.verdict]}</strong>: with the change {percent(summary.withRate)} of checks passed, before it {percent(summary.baselineRate)}
            {summary.delta !== null ? ` (${summary.delta >= 0 ? "+" : ""}${Math.round(summary.delta * 100)} points)` : ""}. Cost about ${summary.costUsd.toFixed(2)}
            {summary.capped ? ", stopped at the cost limit, so some test requests were skipped" : ""}.
          </p>
          {build.evalBefore && (
            <p className="panel-note">
              The round before: {VERDICT_WORD[build.evalBefore.verdict]}, {percent(build.evalBefore.withRate)} with the change. Now {percent(summary.withRate)}.
            </p>
          )}
          <div className="modal-actions">
            <button type="button" aria-expanded={full !== null} aria-controls={`${id}-details`} onClick={() => void showDetails()}>
              Show the details
            </button>
            <button type="button" onClick={() => setAsking(true)}>
              Run again
            </button>
            {(build.round ?? 1) < 3 && (
              <button type="button" onClick={() => setRevising(true)}>
                Revise with this feedback
              </button>
            )}
          </div>
        </>
      )}
      {!summary && !(build.evalRun && !build.evalRun.failed) && build.status === "ready" && (
        <button type="button" className="add-btn" onClick={() => setAsking(true)}>
          <FlaskConical size={16} strokeWidth={1.75} aria-hidden="true" /> Run the skill eval
        </button>
      )}
      {full === "loading" && <p className="panel-note">Loading the details…</p>}
      {full && full !== "loading" && (
        <div className="eval-details" id={`${id}-details`}>
          <p className="panel-note">
            Skill {full.skill}. Baseline: {full.baseline}. Each answer was written in its own session with no tools and graded by a different one.
          </p>
          {full.cases.map((c) => (
            <article key={c.id} className="case-box">
              <h4>Test request {c.id}</h4>
              <p>{c.prompt}</p>
              {"skipped" in c ? (
                <p className="panel-note">Skipped: the cost limit was reached.</p>
              ) : (
                <dl className="item-facts">
                  <dt>With the change</dt>
                  <dd>{sideText(c.withSkill)}</dd>
                  <dt>Before</dt>
                  <dd>{sideText(c.baseline)}</dd>
                  {c.assertions.map((a, i) => (
                    <div key={i} className="check-row">
                      <dt>{a}</dt>
                      <dd>
                        with: {"checks" in c.withSkill ? (c.withSkill.checks[i]?.pass ? "pass" : "fail") : "n/a"}, before: {"checks" in c.baseline ? (c.baseline.checks[i]?.pass ? "pass" : "fail") : "n/a"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </article>
          ))}
        </div>
      )}
      <p role="status" aria-live="polite" className="form-message">
        {message}
      </p>

      <Modal
        open={revising}
        onClose={() => !busy && setRevising(false)}
        title="Start the next round?"
        role="alertdialog"
        description="A new master works in the same copy, given the test requests and checks that did not pass with the change. It writes a plan first and waits for your approval, like any build. When it finishes you can run the eval again and compare the rounds. Three rounds at most; nothing in your skills changes."
      >
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void revise()}>
            {busy ? "Starting…" : "Start the next round"}
          </button>
          <button type="button" disabled={busy} onClick={() => setRevising(false)}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal
        open={asking}
        onClose={() => !busy && setAsking(false)}
        title="Run the skill eval?"
        role="alertdialog"
        description="Each test request is answered twice, with the change and before it, in separate sessions with no tools, and a different session grades each answer. It uses model time: usually 10 to 30 cents for three test requests, and it stops starting new test requests once about $2 is spent. Nothing in your skills changes."
      >
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void run()}>
            {busy ? "Starting…" : "Run the eval"}
          </button>
          <button type="button" disabled={busy} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </div>
      </Modal>
    </section>
  );
}

function demoFull(build: Build): EvalFull {
  const side = (passed: number, total: number): EvalSide => ({ answer: "(demo)", checks: Array.from({ length: total }, (_, i) => ({ pass: i < passed, why: "" })), passed, total });
  return {
    verdict: build.eval?.verdict ?? "improves",
    withRate: build.eval?.withRate ?? 1,
    baselineRate: build.eval?.baselineRate ?? 0.5,
    delta: build.eval?.delta ?? 0.5,
    costUsd: build.eval?.costUsd ?? 0.6,
    capped: false,
    ranAt: build.eval?.ranAt ?? 0,
    skill: "demo-docs",
    baseline: "previous version",
    durationMs: 90_000,
    cases: [
      { id: 1, prompt: "Review this README for me", assertions: ["names accuracy", "mentions links"], withSkill: side(2, 2), baseline: side(1, 2) },
      { id: 2, prompt: "Is my doc any good?", assertions: ["gives a checklist"], withSkill: side(1, 1), baseline: side(0, 1) },
    ],
  };
}
