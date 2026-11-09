import { Hammer, X } from "lucide-react";
import { useCallback, useEffect, useState, type Ref } from "react";
import { EvalPanel } from "./EvalPanel.tsx";
import { getFindings, type Finding } from "./research.ts";
import { DEMO_PATCH, demoBuilds, getBuilds, getPatch, lineKind, startBuild, STATUS_WORD, type Build } from "./workshop.ts";

type Props = {
  id: string;
  demo: boolean;
  /** Why starting work is switched off (demo, disconnected), or null. */
  off: string | null;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
};

const POLL_MS = 10_000;

function PatchView({ build, demo }: { build: Build; demo: boolean }) {
  const [patch, setPatch] = useState<{ patch: string; truncated: boolean } | "loading" | null>("loading");
  useEffect(() => {
    if (demo) return setPatch({ patch: DEMO_PATCH, truncated: false });
    let live = true;
    void getPatch(build.id).then((p) => live && setPatch(p));
    return () => {
      live = false;
    };
  }, [build.id, build.status, demo]);
  if (patch === "loading") return <p className="panel-note">Loading the patch…</p>;
  if (!patch) return <p className="panel-note">The patch could not be read.</p>;
  return (
    <>
      <pre className="patch" tabIndex={0} aria-label={`Patch for ${build.title}`}>
        {patch.patch.split("\n").map((line, i) => (
          <span key={i} className={`patch-${lineKind(line)}`}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      {patch.truncated && <p className="panel-note">The patch is longer than what is shown here. Do not apply it before reading the whole file.</p>}
    </>
  );
}

/** The Workshop: build adopted findings in a copy, then read the patch. Applying it is always the owner's own step. */
export function WorkshopPanel({ id, demo, off, headingRef, onClose }: Props) {
  const [builds, setBuilds] = useState<Build[] | "off" | "loading" | null>("loading");
  const [dir, setDir] = useState("");
  const [adopted, setAdopted] = useState<Finding[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (demo) {
      setBuilds(demoBuilds());
      setDir("<workshop folder>");
      setAdopted([]);
      return;
    }
    const got = await getBuilds();
    // One failed poll must not close the patch being read: keep the list that is already shown.
    setBuilds((now) => (got === null ? (Array.isArray(now) ? now : null) : got === "off" ? "off" : got.builds));
    if (got && got !== "off" && got.dir) setDir(got.dir);
    const found = await getFindings();
    setAdopted(found ? found.findings.filter((f) => f.status === "adopt") : []);
  }, [demo]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const build = async (f: Finding) => {
    setBusy(f.id);
    const result = await startBuild(f.id);
    setBusy("");
    setMessage(result.ok ? "Build started. The master will ask for your approval of its plan first (see Needs you)." : result.message);
    await load();
  };

  return (
    <aside id={id} className="panel board" aria-labelledby={`${id}-title`}>
      <header className="panel-head">
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
          Workshop
        </h2>
        <button type="button" className="icon-btn tip" aria-label="Close workshop" data-tip="Close workshop" onClick={onClose}>
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      {demo && <p className="panel-note">Demo mode: made-up builds. Nothing here is real.</p>}
      <p className="panel-note">
        An adopted finding is built inside a copy of your target folder, never in the folder itself. Its plan always waits for your approval. When it is done, the office writes a patch here for you to read; applying it is your own step.
      </p>
      <p role="status" aria-live="polite" className="form-message">
        {message}
      </p>

      {builds === "off" && (
        <p className="panel-note">The workshop is not set up. Set OFFICE_WORKSHOP_TARGET (the folder to build improvements for) in the .env file and restart the server.</p>
      )}
      {builds === null && <p className="panel-note">The workshop could not be read.</p>}

      {!demo && builds !== "off" && builds !== "loading" && builds !== null && (
        <section aria-labelledby={`${id}-adopted`}>
          <h3 id={`${id}-adopted`}>Ready to build ({adopted.length})</h3>
          {adopted.length === 0 ? (
            <p className="panel-note">Nothing is adopted yet. Mark a finding Adopt in the Research department.</p>
          ) : (
            <ul className="note-list">
              {adopted.map((f) => (
                <li key={f.id}>
                  <strong>{f.title}</strong>
                  {f.fit && <span className="origin"> Fit: {f.fit.verdict}</span>}
                  <button type="button" disabled={Boolean(off) || busy === f.id} title={off ?? undefined} onClick={() => void build(f)}>
                    <Hammer size={16} strokeWidth={1.75} aria-hidden="true" /> {busy === f.id ? "Starting…" : "Build it"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {Array.isArray(builds) && (
        <section aria-labelledby={`${id}-builds`}>
          <h3 id={`${id}-builds`}>Builds ({builds.length})</h3>
          {builds.length === 0 && <p className="panel-note">No builds yet.</p>}
          <ul className="note-list">
            {builds.map((b) => (
              <li key={b.id}>
                <details>
                  <summary>
                    {b.title} <span className="origin">{STATUS_WORD[b.status]}</span>
                  </summary>
                  <p className="panel-note">
                    {new Date(b.createdAt).toLocaleString()} · {b.changed} changed file{b.changed === 1 ? "" : "s"} · copied {b.files} file{b.files === 1 ? "" : "s"}
                  </p>
                  {b.status === "ready" && (
                    <>
                      <PatchView build={b} demo={demo} />
                      <p className="panel-note">
                        To apply: run <code>{`git apply -p1 "${dir}/${b.id}/changes.patch"`}</code> inside your target folder, after reading the patch above.
                      </p>
                      <EvalPanel build={b} demo={demo} onChanged={() => void load()} />
                    </>
                  )}
                  {b.status === "building" && <p className="panel-note">The master is still working or waiting for your approval. The patch appears when it finishes a turn.</p>}
                  {b.status === "too-large" && <p className="panel-note">The change was bigger than 200 KB, so no patch was written. Ask for a smaller change.</p>}
                  {b.status === "error" && <p className="panel-note">The patch could not be made.</p>}
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
