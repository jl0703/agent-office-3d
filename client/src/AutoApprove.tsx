import { useEffect, useId, useState } from "react";
import { getAutoApprove, setAutoApprove, type AutoApprove as Settings } from "./api.ts";

/** The opt-in rule that lets small plans start without asking. Off unless the owner turns it on. */
export function AutoApprove({ off }: { off: string | null }) {
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [rev, setRev] = useState(0); // bumped after every save so a rejected value is replaced by the real one

  useEffect(() => {
    if (!off) void getAutoApprove().then(setSettings);
  }, [off]);

  if (!settings) return null;

  const change = async (next: Partial<Settings>) => {
    setSaving(true);
    const result = await setAutoApprove(next);
    setMessage(result.ok ? "Saved. It applies to plans sent from now on." : result.message);
    const fresh = await getAutoApprove();
    if (fresh) setSettings(fresh);
    setRev((r) => r + 1);
    setSaving(false);
  };

  return (
    <details className="auto-approve">
      <summary>Automatic approval of small plans ({settings.enabled ? "on" : "off"})</summary>
      <p className="panel-note">
        When on, a plan that names 1 to 5 files inside its own folder, with a cost and worker count under the limits below, starts without asking you. The numbers are the master's own claim; the real usage caps and folder limits still apply.
      </p>
      <label className="auto-row">
        <input type="checkbox" checked={settings.enabled} disabled={saving || Boolean(off)} onChange={(e) => void change({ enabled: e.target.checked })} />
        Approve small plans automatically
      </label>
      <label htmlFor={`${id}-cost`}>Highest estimated cost ($)</label>
      <input key={`${settings.maxCostUsd}-${rev}`} id={`${id}-cost`} type="number" min={0} max={2} step={0.1} defaultValue={settings.maxCostUsd} disabled={saving || Boolean(off)} onBlur={(e) => e.target.valueAsNumber !== settings.maxCostUsd && Number.isFinite(e.target.valueAsNumber) && void change({ maxCostUsd: e.target.valueAsNumber })} />
      <label htmlFor={`${id}-workers`}>Most workers</label>
      <input key={`${settings.maxWorkers}-${rev}`} id={`${id}-workers`} type="number" min={0} max={3} step={1} defaultValue={settings.maxWorkers} disabled={saving || Boolean(off)} onBlur={(e) => e.target.valueAsNumber !== settings.maxWorkers && Number.isFinite(e.target.valueAsNumber) && void change({ maxWorkers: e.target.valueAsNumber })} />
      <p role="status" aria-live="polite" className="form-message">
        {message}
      </p>
    </details>
  );
}
