import type { Options } from "@anthropic-ai/claude-agent-sdk";

// The tools a managed worker can use. `tools` limits which built-in tools exist at all;
// `allowedTools` pre-approves them; `dontAsk` denies anything else instead of asking;
// `disallowedTools` is a second wall. Web search is allowed, page fetching is not.
export const WORKER_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "WebSearch"];
export const DENIED_TOOLS = ["Bash", "PowerShell", "WebFetch", "Agent", "Task", "NotebookEdit"];

export const MAX_TURNS = 30;
/** A master spends turns on tool calls to its workers (spawn, wait, collect), so it gets more. */
export const MASTER_MAX_TURNS = 80;
export const MAX_BUDGET_USD = 2;

/** `extraTools` are extra pre-approved tool names (a master's office tools). Workers pass none. */
export function lockdownOptions(extraTools: readonly string[] = []): Pick<
  Options,
  | "permissionMode"
  | "settingSources"
  | "strictMcpConfig"
  | "tools"
  | "allowedTools"
  | "disallowedTools"
  | "maxTurns"
  | "maxBudgetUsd"
> {
  return {
    permissionMode: "dontAsk",
    // Ignore the user's, the repository's, and local settings (which could widen permissions).
    settingSources: [],
    // Ignore MCP servers from the global config, the repository, and claude.ai connectors.
    strictMcpConfig: true,
    tools: [...WORKER_TOOLS, ...extraTools],
    allowedTools: [...WORKER_TOOLS, ...extraTools],
    disallowedTools: [...DENIED_TOOLS],
    maxTurns: extraTools.length > 0 ? MASTER_MAX_TURNS : MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
  };
}
