import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { changedSkillDir, executorPrompt, graderPrompt, parseGrade, readCases, runEval, skillTexts, summarise, supervisorSession, type CaseResult, type EvalCaseInput, type Session } from "../src/skillEval.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "skilleval-")));
  dirs.push(d);
  return d;
};

const cases: EvalCaseInput[] = [
  { id: 1, prompt: "Review this README", assertions: ["names accuracy", "mentions links"] },
  { id: 2, prompt: "Is my doc good?", assertions: ["gives a checklist"] },
];
const allPass = (n: number) => JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ check: i + 1, pass: true, why: "ok" })) });

describe("skill eval: reading the build", () => {
  it("reads the eval cases, refuses an odd file, and finds the changed skill from the patch", async () => {
    const build = tmp();
    mkdirSync(join(build, "a", "docs"), { recursive: true });
    mkdirSync(join(build, "b", "docs"), { recursive: true });
    mkdirSync(join(build, "b", "other"), { recursive: true });
    writeFileSync(join(build, "a", "docs", "SKILL.md"), "old text");
    writeFileSync(join(build, "b", "docs", "SKILL.md"), "new text");
    writeFileSync(join(build, "evals.json"), JSON.stringify({ finding: "x", evals: cases }));
    assert.deepEqual(await readCases(build), cases);
    writeFileSync(join(build, "evals.json"), JSON.stringify({ finding: "x", evals: [{ id: 1, prompt: "", assertions: [] }] }));
    assert.equal(await readCases(build), null);
    assert.equal(await readCases(join(build, "nope")), null);
    const patch = "diff --git a/docs/SKILL.md b/docs/SKILL.md\n--- a/docs/SKILL.md\n+++ b/docs/SKILL.md\n@@ -1 +1 @@\n-old text\n+new text\n";
    assert.equal(await changedSkillDir(build, patch), "docs");
    assert.equal(await changedSkillDir(build, "diff --git a/other/notes.md b/other/notes.md\n"), null, "no SKILL.md above the changed file");
    assert.equal(await changedSkillDir(build, "diff --git a/docs/x.md b/docs/../../x.md\n"), null, "a path that climbs is skipped");
    assert.deepEqual(await skillTexts(build, "docs"), { withSkill: "new text", baseline: "old text" });
    assert.equal((await skillTexts(build, "other"))?.withSkill, undefined, "no skill there");
  });
});

describe("skill eval: prompts and grading", () => {
  it("gives the skill to the executor as instructions, and tells the grader nothing about how the answer was made", () => {
    assert.match(executorPrompt("SKILL BODY", "do it"), /=== SKILL[^]*SKILL BODY[^]*=== END SKILL ===[^]*REQUEST:\ndo it/);
    assert.doesNotMatch(executorPrompt(null, "do it"), /SKILL/);
    const g = graderPrompt("req", "the answer text", ["check one", "check two"]);
    assert.match(g, /1\. check one\n2\. check two/);
    assert.match(g, /<<<\nthe answer text\n>>>/);
    assert.doesNotMatch(g, /skill|without|baseline/i);
  });

  it("reads one result per check in order, and nothing else", () => {
    assert.deepEqual(parseGrade(`Here you go: ${allPass(2)} thanks`, 2)?.map((c) => c.pass), [true, true]);
    assert.equal(parseGrade(allPass(1), 2), null, "too few");
    assert.equal(parseGrade(JSON.stringify({ results: [{ check: 2, pass: true, why: "x" }, { check: 1, pass: true, why: "x" }] }), 2), null, "out of order");
    assert.equal(parseGrade("no json at all", 1), null);
    assert.equal(parseGrade(JSON.stringify({ results: [{ check: 1, pass: "yes", why: "x" }] }), 1), null);
    assert.equal(parseGrade(JSON.stringify({ results: [{ check: 1, pass: true, why: "a‮b" }] }), 1)?.[0]?.why, "a b", "unsafe characters are removed");
  });

  it("calls it better, no different or worse only beyond a margin of 10 points", () => {
    const side = (passed: number, total: number) => ({ answer: "a", checks: [], passed, total });
    const mk = (w: number, b: number): CaseResult[] => [{ id: 1, prompt: "p", assertions: [], withSkill: side(w, 10), baseline: side(b, 10) }];
    assert.equal(summarise(mk(9, 5)).verdict, "improves");
    assert.equal(summarise(mk(6, 5)).verdict, "no-difference");
    assert.equal(summarise(mk(4, 8)).verdict, "worse");
    assert.equal(summarise(mk(9, 5)).delta, 0.4);
    assert.equal(summarise([{ id: 1, prompt: "p", skipped: true }]).verdict, "unclear");
    assert.equal(summarise([{ id: 1, prompt: "p", assertions: [], withSkill: { error: "x" }, baseline: { error: "x" } }]).verdict, "unclear");
  });
});

describe("skill eval: a run", () => {
  // Answers "good" with the skill text in the prompt and "bad" without; the grader passes every check on a good answer only.
  const fake = (): { session: Session; prompts: string[] } => {
    const prompts: string[] = [];
    const session: Session = async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("You grade")) {
        const n = (prompt.match(/^\d+\. /gm) ?? []).length;
        const good = prompt.includes("GOOD ANSWER");
        return { text: JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ check: i + 1, pass: good, why: "judged" })) }), costUsd: 0.01 };
      }
      return { text: prompt.includes("=== SKILL") && !prompt.includes("OLD SKILL") ? "GOOD ANSWER" : "weak answer", costUsd: 0.02 };
    };
    return { session, prompts };
  };

  it("answers each case with and without the skill, grades each answer in its own session, and adds it up", async () => {
    const { session, prompts } = fake();
    const result = await runEval({ cases, skill: { withSkill: "NEW SKILL", baseline: "OLD SKILL" }, skillName: "docs", session, now: () => 1000 });
    assert.equal(prompts.length, 8, "2 cases x (2 answers + 2 graders)");
    assert.equal(prompts.filter((p) => p.startsWith("You grade")).length, 4);
    assert.ok(prompts.filter((p) => p.includes("NEW SKILL")).length === 2 && prompts.filter((p) => p.includes("OLD SKILL")).length === 2);
    assert.ok(prompts.filter((p) => p.startsWith("You grade")).every((p) => !/NEW SKILL|OLD SKILL/.test(p)), "graders never see the skill");
    assert.deepEqual([result.withRate, result.baselineRate, result.delta, result.verdict], [1, 0, 1, "improves"]);
    assert.deepEqual([result.skill, result.baseline, result.costUsd], ["docs", "previous version", 0.12]);
    const noSkill = await runEval({ cases: [cases[0]!], skill: { withSkill: "NEW SKILL", baseline: null }, skillName: "docs", session: fake().session });
    assert.equal(noSkill.baseline, "no skill");
  });

  it("stops starting new cases at the budget, and records a failed session or an unreadable grade as an error, not a pass", async () => {
    const capped = await runEval({ cases, skill: { withSkill: "S", baseline: null }, skillName: "docs", session: fake().session, budgetUsd: 0.05 });
    assert.deepEqual(capped.cases.map((c) => "skipped" in c), [false, true]);
    assert.equal(capped.capped, true);
    const failing = await runEval({ cases: [cases[0]!], skill: { withSkill: "S", baseline: "B" }, skillName: "docs", session: async () => null });
    const only = failing.cases[0];
    assert.ok(only && "withSkill" in only && "error" in only.withSkill && "error" in only.baseline);
    assert.equal(failing.verdict, "unclear");
    const garbled = await runEval({ cases: [cases[0]!], skill: { withSkill: "S", baseline: "B" }, skillName: "docs", session: async (p) => ({ text: p.startsWith("You grade") ? "not json" : "an answer", costUsd: 0 }) });
    assert.equal(garbled.verdict, "unclear");
  });

  it("runs a session as a managed worker: starts it, waits for the answer, reads its cost and stops it", async () => {
    const stopped: string[] = [];
    let polls = 0;
    const session = supervisorSession(
      { startEval: async () => ({ ok: true, id: "s1" }), resultOf: () => (++polls < 3 ? null : "the answer"), stop: async (id) => void stopped.push(id) },
      () => 0.03,
      "/scratch",
      5000,
      1,
    );
    assert.deepEqual(await session("p", "case 1 with answer"), { text: "the answer", costUsd: 0.03 });
    assert.deepEqual(stopped, ["s1"]);
    const refused = supervisorSession({ startEval: async () => ({ ok: false }), resultOf: () => null, stop: async () => undefined }, () => 0, "/s");
    assert.equal(await refused("p", "x"), null);
    const slow = supervisorSession({ startEval: async () => ({ ok: true, id: "s2" }), resultOf: () => null, stop: async (id) => void stopped.push(id) }, () => 0, "/s", 30, 5);
    assert.equal(await slow("p", "x"), null, "a session that never answers is given up on and stopped");
    assert.equal(stopped.at(-1), "s2");
  });
});
