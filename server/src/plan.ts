import { z } from "zod";

// A master's plan, which the owner must approve before any worker starts.
// `PlanInput` is what the model submits; `StoredPlan` adds the decision state.

const line = (max: number) => z.string().min(1).max(max);
export const PlanInput = z.object({
  goal: line(300),
  steps: z.array(line(200)).min(1).max(12),
  files: z.array(line(200)).max(20),
  workers: z.number().int().min(0).max(5),
  costUsd: z.number().min(0).max(50),
  risks: z.string().max(500),
  undo: z.string().max(500),
});

/** The owner's note: one line, no control characters, at most 500 characters. */
export const PLAN_NOTE = /^[^\p{Cc}\p{Cf}\u2028\u2029\uFFFD]*$/u;
export const PlanNote = z.string().max(500).regex(PLAN_NOTE);

export const PlanStatus = z.enum(["pending", "approved", "changes", "rejected"]);
export const StoredPlan = PlanInput.extend({ status: PlanStatus, note: PlanNote.optional(), auto: z.boolean().optional() }).strict();
export const Phase = z.enum(["planning", "executing"]);

export const PlanBody = z.object({ decision: z.enum(["approve", "changes", "reject"]), note: PlanNote.optional() }).strict();
