// What a managed session may inherit from the server's environment.
//
// Anything that would move a session off the user's Claude subscription login is removed:
// API keys, other auth tokens, cloud-provider switches, and base URLs that could send the
// login somewhere else. On Windows environment names are not case sensitive, so matching
// ignores case.
const REMOVED = new Set(
  [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "GITHUB_TOKEN", // only the server's GitHub client uses it
    "OFFICE_SESSION_SECRET", // with it anyone can compute the login token and sign session cookies
  ].map((name) => name.toUpperCase()),
);

// Set by us. Auto memory would let a worker with Write access save files into the Claude
// folder, and claude.ai connectors would load the user's connected services.
const FORCED: Record<string, string> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

export function buildChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const forcedNames = new Set(Object.keys(FORCED).map((name) => name.toUpperCase()));
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (value === undefined || REMOVED.has(upper) || forcedNames.has(upper)) continue;
    out[name] = value;
  }
  return { ...out, ...FORCED };
}
