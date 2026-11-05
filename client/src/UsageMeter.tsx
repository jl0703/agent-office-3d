import type { Usage } from "./api.ts";

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** Estimated usage since the server started, against the cap for all workers together. */
export function UsageMeter({ usage, demo }: { usage: Usage | null; demo: boolean }) {
  if (!usage) return null;
  const share = usage.caps.totalUsd > 0 ? Math.min(1, usage.totalUsd / usage.caps.totalUsd) : 0;
  const near = share >= 0.8;
  const text = `${money(usage.totalUsd)} of ${money(usage.caps.totalUsd)}`;
  return (
    <span className={`usage${near ? " usage-near" : ""}`} title="Estimated usage of all workers since the server started (it protects your plan's limits)">
      <span className="usage-label">Usage{demo ? " (demo)" : ""}</span>
      <span
        className="usage-bar"
        role="meter"
        aria-label="Estimated usage since the server started"
        aria-valuemin={0}
        aria-valuemax={usage.caps.totalUsd}
        aria-valuenow={usage.totalUsd}
        aria-valuetext={`${text}${near ? ", close to the cap" : ""}`}
      >
        <span className="usage-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="usage-text">{text}</span>
    </span>
  );
}
