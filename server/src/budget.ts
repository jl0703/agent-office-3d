// Usage caps, in the SDK's own cost estimates. One run is one `query` (capped by the SDK itself);
// a session adds its runs up across resumes; the app adds up every worker since the server started.
export const DEFAULT_SESSION_BUDGET_USD = 5;
export const DEFAULT_TOTAL_BUDGET_USD = 20;

export type Cap = "run" | "session" | "total";

export function createBudget(limits: { runUsd: number; sessionUsd: number; totalUsd: number }) {
  let total = 0;
  return {
    add(usd: number) {
      if (Number.isFinite(usd) && usd > 0) total += usd;
    },
    total: () => total,
    limits: { ...limits },
    /** The first cap reached, or null. `sessionUsd` already includes the current run. */
    reached(runUsd: number, sessionUsd: number): Cap | null {
      if (runUsd >= limits.runUsd) return "run";
      if (sessionUsd >= limits.sessionUsd) return "session";
      return total >= limits.totalUsd ? "total" : null;
    },
    /** True when another turn must not start: the session or the whole app is out of budget. */
    refuses: (sessionUsd: number) => sessionUsd >= limits.sessionUsd || total >= limits.totalUsd,
  };
}

export type Budget = ReturnType<typeof createBudget>;
