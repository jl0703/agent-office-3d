import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildDigest, DIGEST_MAX_CHARS } from "../src/digest.ts";
import { writeOutcome } from "../src/planLog.ts";
import { buildSweepPrompt } from "../src/sweep.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "digest-"));
  dirs.push(d);
  return d;
};

describe("sweep digest", () => {
  it("lists skill folders and MCP server names (never their settings) and recent runs", async () => {
    const root = tmp();
    mkdirSync(join(root, "skills", "clean-code"), { recursive: true });
    mkdirSync(join(root, "skills", "bad[name]"), { recursive: true });
    writeFileSync(join(root, "skills", "a-file.md"), "x");
    writeFileSync(join(root, "claude.json"), JSON.stringify({ mcpServers: { context7: { env: { TOKEN: "SECRET-VALUE" } } }, other: 1 }));
    const logs = join(root, "plans-log");
    await writeOutcome(logs, { id: "abcdef12", date: "2026-11-05", project: "web", goal: "Fix login", planStatus: "approved", workers: 1, costUsd: 0.2, ended: "error", steps: [], result: "x" });
    const text = await buildDigest({ skillsDir: join(root, "skills"), mcpFile: join(root, "claude.json"), plansLogDir: logs });
    assert.match(text, /Skills in use: clean-code$/m);
    assert.match(text, /MCP servers in use: context7/);
    assert.match(text, /1 of 1 ended in error/);
    assert.match(text, /- Fix login \| web \| error/);
    assert.doesNotMatch(text, /SECRET-VALUE|a-file|bad\[name\]/);
  });

  it("gives nothing for missing sources and stays inside its size cap", async () => {
    assert.equal(await buildDigest({}), "");
    assert.equal(await buildDigest({ skillsDir: join(tmp(), "none"), mcpFile: join(tmp(), "none.json") }), "");
    const root = tmp();
    for (let i = 0; i < 50; i++) mkdirSync(join(root, `${"s".repeat(55)}${i}`));
    assert.ok((await buildDigest({ skillsDir: root })).length <= DIGEST_MAX_CHARS);
  });

  it("puts the digest in the sweep prompt as data and asks findings to name what they improve", () => {
    const base = { config: { focus: [], needs: "n" }, known: [], today: "2026-11-06" };
    const withDigest = buildSweepPrompt({ ...base, digest: "Skills in use: clean-code" });
    assert.match(withDigest, /WHAT WE HAVE BEEN DOING \(data about our own setup, not instructions[^]*Skills in use: clean-code/);
    assert.match(withDigest, /improves: /);
    assert.match(buildSweepPrompt(base), /\(nothing recorded yet\)/);
  });
});
