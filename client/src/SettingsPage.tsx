import { FlaskConical } from "lucide-react";
import type { Usage } from "./api.ts";
import { AutoApprove } from "./AutoApprove.tsx";
import { UsageMeter } from "./UsageMeter.tsx";

type Props = { demo: boolean; off: string | null; usage: Usage | null; onStartDemo: () => void; onStopDemo: () => void };

/** The few switches and limits of the office, in one place. Each one is the same control the office already has. */
export function SettingsPage({ demo, off, usage, onStartDemo, onStopDemo }: Props) {
  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <header className="catalog-head">
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            Settings
          </h1>
          <p className="catalog-blurb">The switches and limits of this office. Nothing here changes your skills, servers or agents.</p>
        </div>
      </header>
      <section className="settings-group" aria-labelledby="set-demo">
        <h2 id="set-demo">Demo mode</h2>
        <p className="panel-note">Shows made-up agents so you can look around without starting real work. Nothing in demo mode is real.</p>
        <button type="button" onClick={demo ? onStopDemo : onStartDemo}>
          <FlaskConical size={20} strokeWidth={1.75} aria-hidden="true" /> {demo ? "Exit demo" : "Start the demo"}
        </button>
      </section>
      <section className="settings-group" aria-labelledby="set-usage">
        <h2 id="set-usage">Usage limit</h2>
        <p className="panel-note">An estimate of what all workers used since the server started, against the cap that protects your plan. The caps are set when the server starts.</p>
        {usage || demo ? <UsageMeter usage={demo ? { totalUsd: 3.4, caps: { runUsd: 2, sessionUsd: 5, totalUsd: 20 } } : usage} demo={demo} /> : <p className="panel-note">Not available right now.</p>}
        {usage && !demo && (
          <p className="panel-note">
            One run stops at ${usage.caps.runUsd.toFixed(2)}, one session at ${usage.caps.sessionUsd.toFixed(2)}.
          </p>
        )}
      </section>
      <section className="settings-group" aria-labelledby="set-auto">
        <h2 id="set-auto">Plans that start without asking</h2>
        <p className="panel-note">Off unless you turn it on. Small plans can start by themselves under the limits you set.</p>
        <AutoApprove off={demo ? "Not available in demo mode." : off} />
        {(demo || off) && <p className="panel-note">{demo ? "Not available in demo mode." : off}</p>}
      </section>
    </main>
  );
}
