import type { ChildProcess } from "node:child_process";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createChannel } from "../src/channel.ts";
import type { StoredWorker } from "../src/managedStore.ts";
import type { QueryFn } from "../src/supervisor.ts";

export type FakeOptions = {
  sessionId?: () => string;
  apiKeySource?: string;
  /** Wait this long before the first message. */
  initDelayMs?: number;
  /** Never send the first message. */
  neverInit?: boolean;
  /** End the stream without ever sending the first message. */
  endBeforeInit?: boolean;
  /** Ignore the interrupt and a closed input; only an abort ends the stream. */
  stubborn?: boolean;
  /** Start a real, harmless child process through the supplied spawn function. */
  spawnChild?: boolean;
  /** Make that child exit at once. */
  childExits?: boolean;
  /** Make the stream throw right after the first message. */
  throwAfterInit?: boolean;
};

export type FakeSession = {
  out: ReturnType<typeof createChannel<SDKMessage>>;
  interrupts: number;
  prompts: SDKUserMessage[];
  childPid: number | null;
  /** A process started by the child, to check that stopping kills the whole tree. */
  grandchildPid: number | null;
  aborted: boolean;
};

const THROW = { type: "__throw__" } as unknown as SDKMessage;

export const initMessage = (sessionId: string, apiKeySource = "none") =>
  ({ type: "system", subtype: "init", session_id: sessionId, apiKeySource, cwd: "", tools: [] }) as unknown as SDKMessage;

/** The end of a turn. `costUsd` is the run's total so far, as the SDK reports it. */
export const resultMessage = (costUsd: number, subtype = "success") =>
  ({ type: "result", subtype, total_cost_usd: costUsd, session_id: "x" }) as unknown as SDKMessage;

export const rateLimitMessage = (status: string, resetsAt?: number) =>
  ({ type: "rate_limit_event", rate_limit_info: { status, ...(resetsAt === undefined ? {} : { resetsAt }) }, uuid: "u", session_id: "x" }) as unknown as SDKMessage;

export const rateLimitedReply = () =>
  ({ type: "assistant", error: "rate_limit", parent_tool_use_id: null, session_id: "x", message: { content: [] } }) as unknown as SDKMessage;

/** A worker as the file stores it. */
export const storedWorker = (id: string, over: Partial<StoredWorker> = {}): StoredWorker => ({
  id,
  name: "Fixer",
  project: "demo",
  task: "fix the bug",
  cwd: "C:\\work\\demo",
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 1000,
  pid: null,
  processName: null,
  pidStartedAt: null,
  costUsdTotal: 0,
  ...over,
});

export const toolMessage = (id: string, name: string, input: object) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "x",
    message: { content: [{ type: "tool_use", id, name, input }] },
  }) as unknown as SDKMessage;

export function createFake(opts: FakeOptions = {}) {
  const calls: Options[] = [];
  const sessions: FakeSession[] = [];

  const query: QueryFn = ({ prompt, options }) => {
    const out = createChannel<SDKMessage>();
    const session: FakeSession = { out, interrupts: 0, prompts: [], childPid: null, grandchildPid: null, aborted: false };
    sessions.push(session);
    calls.push(options);
    const sessionId = opts.sessionId ? opts.sessionId() : `session-${sessions.length}`;
    options.abortController?.signal.addEventListener("abort", () => {
      session.aborted = true;
      out.close();
    });

    void (async () => {
      if (opts.spawnChild && options.spawnClaudeCodeProcess && options.abortController) {
        const child = options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: opts.childExits ? ["-e", ""] : [
            "-e",
            `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform === "win32" });
             console.log(c.pid); setInterval(() => {}, 1000);`,
          ],
          cwd: options.cwd,
          env: options.env ?? {},
          signal: options.abortController.signal,
        }) as unknown as ChildProcess;
        session.childPid = child.pid ?? null;
        child.stdout?.once("data", (data: Buffer) => {
          session.grandchildPid = Number(String(data).trim()) || null;
        });
      }
      if (opts.initDelayMs) await new Promise((r) => setTimeout(r, opts.initDelayMs));
      if (opts.endBeforeInit) return out.close();
      if (!opts.neverInit) out.push(initMessage(sessionId, opts.apiKeySource ?? "none"));
      if (opts.throwAfterInit) out.push(THROW);
      for await (const message of prompt) session.prompts.push(message);
      if (!opts.stubborn) out.close();
    })();

    async function* stream() {
      for await (const message of out.iterable) {
        if (message === THROW) throw new Error("boom");
        yield message;
      }
    }
    return Object.assign(stream(), {
      interrupt: async () => {
        session.interrupts++;
      },
    }) as unknown as Query;
  };

  return { query, calls, sessions };
}
