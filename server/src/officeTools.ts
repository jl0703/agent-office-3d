import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PlanInput } from "./plan.ts";

// The master's seven tools. They run inside this process (the SDK's in-process tool server):
// no port, no route. The master's identity is fixed by the supervisor when it builds the
// server, so nothing the model writes can name another owner.

export const OFFICE_SERVER = "office";
const TOOLS = ["spawn_worker", "assign_task", "wait_for_workers", "stop_worker", "list_workers", "submit_plan", "suggest_task"] as const;
export const OFFICE_TOOL_NAMES = TOOLS.map((name) => `mcp__${OFFICE_SERVER}__${name}`);

export const MAX_WAIT_SECONDS = 120;
export const MAX_RESULT_CHARS = 2000;
/** The SDK's own limit per tool call. Above the longest wait, so a wait ends by our rule first. */
const TOOL_TIMEOUT_MS = (MAX_WAIT_SECONDS + 30) * 1000;

export type Reply = { ok: true; data: unknown } | { ok: false; error: string };

/** What the tools may do. Built by the supervisor for one master. */
export type OfficeApi = {
  spawn(args: { name: string; folder: string; task: string }): Promise<Reply>;
  assign(id: string, task: string): Reply;
  wait(ids: string[] | undefined, seconds: number): Promise<Reply>;
  stop(id: string): Promise<Reply>;
  list(): Reply;
  submitPlan(plan: z.infer<typeof PlanInput>): Reply | Promise<Reply>;
  suggestTask(args: { title: string; details: string }): Promise<Reply>;
};

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const task = z.string().min(1).max(10_000);

export const MASTER_SYSTEM_PROMPT = `You are a master agent in a small office. You split a big job into parts and run worker agents on them.
Office tools: spawn_worker (name, folder, task) starts a worker and returns its id at once; assign_task (id, task) gives an idle worker its next task; wait_for_workers (ids optional, timeout_s up to ${MAX_WAIT_SECONDS}) waits and returns each worker's state and last result, or "still working" at the timeout, in which case call it again; list_workers shows your workers; stop_worker (id) stops one; suggest_task (title, details) proposes a task for the owner's board, which the owner may accept or dismiss (you cannot assign or start it, and you may suggest only a few).
Rules: you can only control workers you started. Workers can read, search, edit and write files and search the web; they cannot run commands and cannot start workers. A worker's folder must be inside your own folder. Be economical: start only as many workers as the job needs (at most a few at once), give each a self-contained task that names the files and the expected result, read the results and check them, and stop every worker when its work is done. Never put secrets in a task.`;

/** Appended for a master that must have its plan approved first (every master except the research sweep's Lead). */
export const PLAN_FIRST_PROMPT = `Plan first: you start in a read-only planning phase (Read, Glob, Grep, WebSearch and the list/wait tools only; no Write, Edit or workers). Study the job, then call submit_plan (goal, steps, files, workers, costUsd, risks, undo) and end your turn. Wait for the owner's decision: it arrives as your next message. If changes are asked for, revise and submit_plan again. Never start workers before your plan is approved.`;

const text = (reply: Reply) => ({
  content: [{ type: "text" as const, text: reply.ok ? JSON.stringify(reply.data) : reply.error }],
  ...(reply.ok ? {} : { isError: true }),
});

export function createOfficeServer(api: OfficeApi) {
  return createSdkMcpServer({
    name: OFFICE_SERVER,
    timeout: TOOL_TIMEOUT_MS,
    tools: [
      tool(
        "spawn_worker",
        "Start a worker agent in a folder inside your own folder. Returns its id at once; the worker then runs the task in the background.",
        { name: z.string().min(1).max(100), folder: z.string().min(1).max(1000), task },
        async (args) => text(await api.spawn(args)),
      ),
      tool(
        "assign_task",
        "Give one of your idle workers a new task. Returns at once.",
        { id, task },
        async (args) => text(api.assign(args.id, args.task)),
      ),
      tool(
        "wait_for_workers",
        `Wait until your workers (all of them, or the given ids) are no longer working, for at most timeout_s seconds (up to ${MAX_WAIT_SECONDS}). Returns each worker's state and last result.`,
        { ids: z.array(id).min(1).max(20).optional(), timeout_s: z.number().int().min(1).max(MAX_WAIT_SECONDS) },
        async (args) => text(await api.wait(args.ids, args.timeout_s)),
      ),
      tool("stop_worker", "Stop one of your workers.", { id }, async (args) => text(await api.stop(args.id))),
      tool("list_workers", "List your workers and their states.", {}, async () => text(api.list())),
      tool(
        "submit_plan",
        "Submit your plan for the owner's approval while you are in the planning phase. Submitting again replaces the plan. Afterwards end your turn and wait for the decision.",
        PlanInput.shape,
        async (args) => text(await api.submitPlan(args)),
      ),
      tool(
        "suggest_task",
        "Propose a task for the owner's task board (a short title and details). It appears as a suggestion; the owner decides whether to keep it and who gets it. You cannot start or assign it.",
        { title: z.string().min(1).max(200), details: z.string().max(3000) },
        async (args) => text(await api.suggestTask(args)),
      ),
    ],
  });
}
