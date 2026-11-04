import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createBudget } from "../src/budget.ts";
import { transcriptActive } from "../src/transcriptActivity.ts";

const dir = mkdtempSync(join(tmpdir(), "activity-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function logFile(project: string, id: string, ageMs: number) {
  mkdirSync(join(dir, project), { recursive: true });
  const path = join(dir, project, `${id}.jsonl`);
  writeFileSync(path, "{}\n");
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
}

describe("transcript activity", () => {
  it("is active only when the session log was written to in the last 10 seconds", async () => {
    logFile("p1", "fresh", 1000);
    logFile("p2", "stale", 60_000);
    assert.equal(await transcriptActive(dir, "fresh"), true);
    assert.equal(await transcriptActive(dir, "stale"), false);
    assert.equal(await transcriptActive(dir, "missing"), false);
    assert.equal(await transcriptActive(join(dir, "no-such-folder"), "fresh"), false);
  });

  it("does not look up an id that is not a plain name", async () => {
    logFile("p3", "x", 100);
    writeFileSync(join(dir, "secret.jsonl"), "{}");
    for (const id of ["../secret", "p3/x", "", "a b"]) assert.equal(await transcriptActive(dir, id), false, JSON.stringify(id));
  });
});

describe("budget", () => {
  const limits = { runUsd: 2, sessionUsd: 5, totalUsd: 20 };
  it("names the first cap that is reached", () => {
    const b = createBudget(limits);
    assert.equal(b.reached(1.99, 1.99), null);
    assert.equal(b.reached(2, 2), "run");
    assert.equal(b.reached(1.5, 5), "session");
    b.add(19);
    assert.equal(b.reached(1, 1), null);
    b.add(1);
    assert.equal(b.reached(1, 1), "total");
  });

  it("refuses another turn when the session or the whole app is used up", () => {
    const b = createBudget(limits);
    assert.equal(b.refuses(4.99), false);
    assert.equal(b.refuses(5), true);
    b.add(20);
    assert.equal(b.refuses(0), true);
  });

  it("ignores amounts that are not positive numbers", () => {
    const b = createBudget(limits);
    for (const bad of [-5, NaN, 0]) b.add(bad);
    assert.equal(b.total(), 0);
  });
});
