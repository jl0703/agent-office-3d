import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextStep, stagesOf } from "../src/pipeline.ts";
import type { Finding } from "../src/research.ts";
import type { Build } from "../src/workshop.ts";

const find = (over: Partial<Finding> = {}): Finding => ({ id: "a", kind: "skill", title: "A", url: "https://x.y", relevance: 3, effort: "low", risk: "low", found_by: "s", date: "2026-11-09", why: "w", status: "new", ...over });
const fit = { verdict: "fits", how: "h", conflicts: "c", security: "s", effort: "low", rollback: "r", date: "2026-11-09" } as const;
const brief = { goal: "g", files: "f", criteria: "c", date: "2026-11-09", written_by: "b", cases: [{ prompt: "p", assertions: ["a check"] }, { prompt: "q", assertions: ["b check"] }] };
const build = (over: Partial<Build> = {}): Build => ({ id: "0123456789ab", finding: "a", title: "A", createdAt: 1, status: "ready", files: 1, changed: 1, ...over });
const states = (f: Finding, builds: Build[] = []) => stagesOf(f, builds).map((s) => s.state).join(",");

describe("pipeline stages", () => {
  it("walks from found to built, and marks the first stage not done as current", () => {
    assert.equal(states(find()), "done,current,todo,todo");
    assert.equal(states(find({ fit })), "done,done,current,todo");
    assert.equal(states(find({ fit, brief })), "done,done,done,current");
    assert.equal(states(find({ fit, brief }), [build()]), "done,done,done,done");
  });

  it("counts a finished build of this find only, and a build still running is not done", () => {
    assert.equal(states(find({ fit, brief }), [build({ finding: "other" })]), "done,done,done,current");
    assert.equal(states(find({ fit, brief }), [build({ status: "building" })]), "done,done,done,current");
    assert.equal(states(find({ fit, brief }), [build({ status: "no-changes" })]), "done,done,done,done");
    assert.equal(states(find({ brief })), "done,current,done,todo", "a brief written without a fit check leaves the fit stage current");
  });

  it("says what to do next", () => {
    assert.match(nextStep(find()), /Looking/);
    assert.match(nextStep(find({ status: "looking" })), /Check fit/);
    assert.match(nextStep(find({ fit, status: "looking" })), /Adopt/);
    assert.match(nextStep(find({ fit, status: "adopt" })), /Write the brief/);
    assert.match(nextStep(find({ fit, brief, status: "adopt" })), /Build in the Workshop/);
    assert.match(nextStep(find({ fit, brief, status: "adopt" }), [build()]), /apply it yourself/);
  });
});
