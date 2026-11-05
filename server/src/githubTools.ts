import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FULL_NAME, MAX_LIMIT, type Github, type GithubReply } from "./github.ts";

// The research workers' two read-only GitHub tools, as an in-process tool server.

export const GITHUB_SERVER = "github";
export const GITHUB_TOOL_NAMES = ["github_search_repos", "github_repo"].map((name) => `mcp__${GITHUB_SERVER}__${name}`);

const text = (reply: GithubReply<unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(reply.ok ? reply.data : { error: reply.error, ...(reply.retry_after_s ? { retry_after_s: reply.retry_after_s } : {}) }) }],
  ...(reply.ok ? {} : { isError: true }),
});

export function createGithubServer(github: Github) {
  return createSdkMcpServer({
    name: GITHUB_SERVER,
    tools: [
      tool(
        "github_search_repos",
        "Search public GitHub repositories. Returns stars, forks, open issues, short description, topics, licence, language, last push and URL. Use this for exact star counts.",
        {
          query: z.string().min(1).max(120).regex(/^[A-Za-z0-9 _.-]+$/),
          sort: z.enum(["stars", "updated"]),
          topic: z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/).optional(),
          language: z.string().regex(/^[A-Za-z0-9+#.-]{1,30}$/).optional(),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        },
        async (args) => text(await github.searchRepos(args)),
      ),
      tool(
        "github_repo",
        "Get one public GitHub repository by owner/name, with its latest release tag.",
        { full_name: z.string().regex(FULL_NAME) },
        async (args) => text(await github.getRepo(args.full_name)),
      ),
    ],
  });
}
