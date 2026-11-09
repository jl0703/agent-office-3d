import type { Finding } from "./research.ts";
import type { Build } from "./workshop.ts";

// Where a find is on its way from research to a patch you can apply. Worked out from what already exists, so there is no
// extra state to keep in step: a fit report, a brief, a workshop build.

export type StageState = "done" | "current" | "todo";
export type Stage = { id: "found" | "fit" | "brief" | "built" | "eval"; label: string; state: StageState };

/** The stages in order; the first one not done is the current one. */
export function stagesOf(f: Finding, builds: readonly Build[] = []): Stage[] {
  const mine = builds.filter((b) => b.finding === f.id);
  const built = mine.some((b) => b.status === "ready" || b.status === "no-changes" || b.status === "too-large");
  const evaluated = mine.some((b) => b.eval !== undefined);
  const done = [true, Boolean(f.fit), Boolean(f.brief), built, evaluated];
  const labels: [Stage["id"], string][] = [["found", "Found"], ["fit", "Fit checked"], ["brief", "Briefed"], ["built", "Built"], ["eval", "Evaluated"]];
  const firstTodo = done.findIndex((d) => !d);
  return labels.map(([id, label], i) => ({ id, label, state: done[i] ? "done" : i === firstTodo ? "current" : "todo" }));
}

/** The one thing worth doing next, in words. */
export function nextStep(f: Finding, builds: readonly Build[] = []): string {
  const stage = stagesOf(f, builds).find((s) => s.state === "current");
  if (!stage) return "Evaluated. Read the patch and the eval in the Workshop, and apply it yourself if you are happy.";
  if (stage.id === "eval") return "Press Run the skill eval on the build.";
  if (stage.id === "fit") return f.status === "looking" ? "Press Check fit." : "Mark it Looking, then press Check fit.";
  if (stage.id === "brief") return f.status === "adopt" ? "Press Write the brief." : "Mark it Adopt to have a brief written.";
  return f.status === "adopt" ? "Press Build in the Workshop." : "Mark it Adopt to build it.";
}
