import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createDecisionStore,
  DEFAULT_FOCUS,
  ensureResearchLayout,
  MAX_DECISIONS,
  MAX_FINDING_FILES,
  parseFrontmatter,
  readConfig,
  readFinding,
  readFindings,
  withDecisions,
  writeConfig,
} from "../src/findings.ts";
import { realOps } from "../src/managedStore.ts";

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "findings-")));
  made.push(d);
  return d;
};

const FIELDS: Record<string, string> = {
  id: "good-one",
  kind: "mcp",
  title: "A good MCP server",
  url: "https://github.com/a/b",
  stars: "1234",
  license: "MIT",
  relevance: "4",
  effort: "low",
  risk: "medium",
  found_by: "repo-scout",
  date: "2026-11-05",
  why: "Gives workers a code review tool.",
};
const note = (over: Record<string, string | null> = {}, body = "Body text.\n") => {
  const merged = { ...FIELDS, ...over };
  const lines = Object.entries(merged).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
};
const parse = (text: string, id = "good-one") => parseFrontmatter(text, id);

describe("frontmatter parser (D1)", () => {
  it("reads a complete note and ignores unknown keys and blank lines", () => {
    const f = parse(note({ extra: "ignored" }).replace("kind:", "\nkind:"));
    assert.deepEqual(f, {
      id: "good-one", kind: "mcp", title: "A good MCP server", url: "https://github.com/a/b", stars: 1234, license: "MIT",
      relevance: 4, effort: "low", risk: "medium", found_by: "repo-scout", date: "2026-11-05", why: "Gives workers a code review tool.",
    });
  });

  it("makes stars and licence optional (an empty value counts as missing) and accepts CRLF", () => {
    const f = parse(note({ stars: null, license: "" }).replace(/\n/g, "\r\n"));
    assert.ok(f);
    assert.equal("stars" in f, false);
    assert.equal("license" in f, false);
  });

  it("requires the id to equal the file name", () => {
    assert.equal(parse(note(), "other-name"), null);
    assert.equal(parse(note({ id: "Good-One" }), "Good-One"), null);
    assert.equal(parse(note({ id: "-bad" }), "-bad"), null);
    assert.equal(parse(note({ id: "a".repeat(81) }), "a".repeat(81)), null);
    assert.ok(parse(note({ id: "a".repeat(80) }), "a".repeat(80)));
  });

  for (const url of ["http://github.com/a/b", "javascript:alert(1)", "data:text/html,x", "ftp://x.org/a", "file:///etc/passwd", "HTTPS://github.com/a", "https://github.com/a b", "https://user:pw@github.com/a", "https://", "//github.com/a", `https://x.org/${"a".repeat(300)}`, "https://x.org/a\u0007"]) {
    it(`rejects the url ${JSON.stringify(url.slice(0, 40))}`, () => assert.equal(parse(note({ url })), null));
  }

  for (const [key, value] of [
    ["title", "bad\u0007title"], ["title", "tab\there"], ["title", "rtl‮override"], ["title", "zero​width"], ["title", "x".repeat(121)], ["title", ""],
    ["kind", "plugin"], ["effort", "none"], ["risk", "HIGH"], ["relevance", "0"], ["relevance", "6"], ["relevance", "3.5"],
    ["stars", "-1"], ["stars", "1e3"], ["stars", "12 34"], ["license", "x".repeat(41)], ["found_by", "x".repeat(41)],
    ["date", "2026-02-30"], ["date", "2026-2-3"], ["date", "2026-13-01"], ["date", "05-11-2026"], ["why", "x".repeat(401)], ["why", ""],
  ] as const) {
    it(`rejects ${key} = ${JSON.stringify(value.slice(0, 20))}`, () => assert.equal(parse(note({ [key]: value })), null));
  }

  it("rejects missing required fields", () => {
    for (const key of ["id", "kind", "title", "url", "relevance", "effort", "risk", "found_by", "date", "why"]) {
      assert.equal(parse(note({ [key]: null })), null, key);
    }
  });

  it("rejects YAML tricks and anything that is not plain key: value lines", () => {
    assert.equal(parse(note({ title: "one" }).replace("kind:", "title: two\nkind:")), null, "repeated key");
    assert.equal(parse(note().replace("why:", "  indented: no\nwhy:")), null, "indented line");
    assert.equal(parse(note().replace("why:", "- list item\nwhy:")), null, "list");
    assert.equal(parse(note().replace("why:", "just words\nwhy:")), null, "line without a colon");
    assert.equal(parse(note({ why: "first" }).replace("\n---\n", "\n  continued\n---\n")), null, "continuation line");
    assert.equal(parse(note().replace("---\n", "---\r\r\n")), null, "bare carriage return");
  });

  it("requires the opening line at the very start and a closing line", () => {
    assert.equal(parse("\n" + note()), null, "blank line first");
    assert.equal(parse("﻿" + note()), null, "byte order mark");
    assert.equal(parse("--- \n" + note().slice(4)), null, "opening line with a space");
    assert.equal(parse(note().replace(/\n---\n.*$/s, "\n")), null, "no closing line");
    assert.equal(parse(note().replace("\n---\n", "\n----\n")), null, "closing line of four dashes");
    assert.equal(parse("not a note at all"), null);
    assert.equal(parse(""), null);
  });

  it("rejects binary content and replacement characters", () => {
    assert.equal(parse(note({ why: "a\u0000b" })), null);
    assert.equal(parse(note({ why: "bad � bytes" })), null);
    assert.equal(parse(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]).toString("utf8")), null);
  });
});

function folder(files: Record<string, string | Buffer> = {}) {
  const research = tmp();
  mkdirSync(join(research, "findings"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(research, "findings", name), text);
  return research;
}
const named = (id: string, over: Record<string, string | null> = {}) => note({ id, url: `https://github.com/x/${id}`, ...over });

describe("reading the findings folder (D1)", () => {
  it("lists valid notes newest first by date, then file time, and counts the ignored ones", async () => {
    const research = folder({
      "a-old.md": named("a-old", { date: "2026-01-01" }),
      "b-new.md": named("b-new", { date: "2026-11-05" }),
      "c-mid.md": named("c-mid", { date: "2026-06-01" }),
      "bad-id.md": named("not-the-name"),
      "broken.md": "no frontmatter",
      "Upper.md": named("upper"),
      "notes.txt": "ignored, not a note",
    });
    mkdirSync(join(research, "findings", "sub.md"));
    const { findings, invalid } = await readFindings(research);
    assert.deepEqual(findings.map((f) => f.id), ["b-new", "c-mid", "a-old"]);
    assert.equal(invalid, 3);
  });

  it("answers empty when the findings folder is missing", async () => {
    assert.deepEqual(await readFindings(tmp()), { findings: [], invalid: 0 });
  });

  it("keeps one card per link: the newest note wins", async () => {
    const research = folder({
      "old.md": note({ id: "old", date: "2026-01-01", url: "https://github.com/a/b" }),
      "new.md": note({ id: "new", date: "2026-02-01", url: "https://GitHub.com/a/b/" }),
    });
    assert.deepEqual((await readFindings(research)).findings.map((f) => f.id), ["new"]);
  });

  it("reads only the first 8 KB: a huge body is never read or served, and a frontmatter that ends later is invalid", async () => {
    const secret = "SECRET-IN-THE-BODY-9f3a";
    const research = folder({
      "huge.md": named("huge", {}) + `${secret}\n` + "x".repeat(6 * 1024 * 1024),
      "late.md": named("late").replace("why:", `pad: ${"x".repeat(9000)}
why:`),
      "tiny.md": named("tiny") + secret,
    });
    const { findings, invalid } = await readFindings(research);
    assert.deepEqual(findings.map((f) => f.id).sort(), ["huge", "tiny"]);
    assert.equal(invalid, 1);
    assert.equal(JSON.stringify(findings).includes(secret), false);
    assert.ok(await readFinding(research, "huge"));
    assert.equal(await readFinding(research, "late"), null);
  });

  it("ignores binary files and files whose id does not match", async () => {
    const research = folder({ "bin.md": Buffer.from([0, 1, 2, 3, 255, 254, 0]), "wrong.md": named("right") });
    assert.deepEqual(await readFindings(research), { findings: [], invalid: 2 });
  });

  it("reads at most 500 files and counts the rest as ignored", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_FINDING_FILES + 3; i++) files[`f${String(i).padStart(4, "0")}.md`] = named(`f${String(i).padStart(4, "0")}`);
    const { findings, invalid } = await readFindings(folder(files));
    assert.equal(findings.length, MAX_FINDING_FILES);
    assert.equal(invalid, 3);
  });

  it("does not follow a findings folder that is a junction to outside the research folder", async () => {
    const research = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "leak.md"), named("leak"));
    symlinkSync(outside, join(research, "findings"), "junction");
    assert.deepEqual(await readFindings(research), { findings: [], invalid: 0 });
    assert.equal(await readFinding(research, "leak"), null);
  });

  it("does not follow a note that is a link to a file outside the folder, but does follow one inside", async (t) => {
    const research = folder({ "real.md": named("real") });
    const outside = tmp();
    writeFileSync(join(outside, "leak.md"), named("leak"));
    try {
      symlinkSync(join(outside, "leak.md"), join(research, "findings", "leak.md"), "file");
      symlinkSync(join(research, "findings", "real.md"), join(research, "findings", "alias.md"), "file");
    } catch {
      return t.skip("file links are not allowed on this machine");
    }
    const { findings, invalid } = await readFindings(research);
    assert.deepEqual(findings.map((f) => f.id), ["real"]); // alias has the wrong id for its name, leak is outside
    assert.equal(invalid, 2);
    assert.equal(await readFinding(research, "leak"), null);
  });

  it("only treats a safe id as a file name", async () => {
    const research = folder({ "ok.md": named("ok") });
    for (const id of ["../ok", "ok.md", "a/b", "OK", "", "a\\b"]) assert.equal(await readFinding(research, id), null, id);
  });
});

describe("the decisions store (D1)", () => {
  const fileOf = (dir: string) => join(dir, "research-decisions.json");

  it("stores a decision, keeps it across a new instance, and removes it when set back to new without a note", async () => {
    const dir = tmp();
    const a = createDecisionStore(dir, realOps, () => Date.UTC(2026, 10, 5));
    assert.equal(await a.set("one", { status: "adopt", note: "great" }), "ok");
    assert.equal(await a.set("two", { status: "reject" }), "ok");
    const b = createDecisionStore(dir);
    assert.deepEqual([...(await b.all())], [
      ["one", { status: "adopt", note: "great", updatedAt: "2026-11-05T00:00:00.000Z" }],
      ["two", { status: "reject", updatedAt: "2026-11-05T00:00:00.000Z" }],
    ]);
    await b.set("one", { status: "new" });
    assert.deepEqual([...(await createDecisionStore(dir).all()).keys()], ["two"]);
    assert.equal(JSON.parse(readFileSync(fileOf(dir), "utf8")).version, 1);
  });

  it("merges decisions into findings and defaults to new", async () => {
    const dir = tmp();
    const store = createDecisionStore(dir);
    await store.set("good-one", { status: "later", note: "after the beta" });
    const f = parse(note());
    assert.ok(f);
    assert.deepEqual(withDecisions([f, { ...f, id: "other" }], await store.all()).map((x) => [x.status, x.note]), [["later", "after the beta"], ["new", undefined]]);
  });

  it("sets a damaged or wrongly shaped file aside and starts empty", async () => {
    for (const text of ["{not json", JSON.stringify({ version: 2, decisions: {} }), JSON.stringify({ version: 1, decisions: { "Bad Id": { status: "adopt", updatedAt: "x" } } }), JSON.stringify({ version: 1, decisions: { ok: { status: "maybe", updatedAt: "x" } } }), JSON.stringify({ version: 1, decisions: {}, extra: 1 })]) {
      const dir = tmp();
      writeFileSync(fileOf(dir), text);
      const store = createDecisionStore(dir);
      assert.equal((await store.all()).size, 0);
      assert.equal(existsSync(`${fileOf(dir)}.bad`), true, text);
      assert.equal(await store.set("x", { status: "looking" }), "ok");
      assert.equal((await createDecisionStore(dir).all()).size, 1);
    }
  });

  it("holds at most 1000 entries but still lets an existing one change", async () => {
    const dir = tmp();
    const decisions = Object.fromEntries(Array.from({ length: MAX_DECISIONS }, (_, i) => [`n${i}`, { status: "later", updatedAt: "2026-11-05T00:00:00.000Z" }]));
    writeFileSync(fileOf(dir), JSON.stringify({ version: 1, decisions }));
    const store = createDecisionStore(dir);
    assert.equal(await store.set("one-more", { status: "adopt" }), "full");
    assert.equal(await store.set("n5", { status: "adopt" }), "ok");
    assert.equal((await store.all()).size, MAX_DECISIONS);
    writeFileSync(fileOf(dir), JSON.stringify({ version: 1, decisions: { ...decisions, extra: decisions["n1"] } }));
    assert.equal((await createDecisionStore(dir).all()).size, 0, "a file with more than 1000 entries is set aside");
  });

  it("writes through a temporary file: a failed write keeps the old file and leaves no temporary file", async () => {
    const dir = tmp();
    const store = createDecisionStore(dir);
    await store.set("one", { status: "adopt" });
    const before = readFileSync(fileOf(dir), "utf8");
    const broken = createDecisionStore(dir, { writeFile: realOps.writeFile, rename: async () => { throw Object.assign(new Error("no"), { code: "ENOSPC" }); } });
    await assert.rejects(broken.set("two", { status: "reject" }));
    assert.equal(readFileSync(fileOf(dir), "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["research-decisions.json"]);
    assert.equal((await broken.all()).has("two"), false, "memory matches the disk");
  });

  it("retries a rename that Windows refuses for a moment", async () => {
    const dir = tmp();
    let failures = 2;
    const store = createDecisionStore(dir, { writeFile: realOps.writeFile, rename: async (a, b) => {
      if (failures-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" });
      return rename(a, b);
    } });
    assert.equal(await store.set("one", { status: "looking" }), "ok");
    assert.equal(failures, -1);
    assert.equal((await createDecisionStore(dir).all()).size, 1);
  });

  it("keeps every write of many at once", async () => {
    const dir = tmp();
    const store = createDecisionStore(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.set(`id-${i}`, { status: "later" })));
    assert.equal((await createDecisionStore(dir).all()).size, 25);
  });
});

describe("focus and needs notes (D1)", () => {
  it("creates findings/ and the two default notes, and never overwrites existing ones", async () => {
    const dir = tmp();
    await ensureResearchLayout(dir);
    assert.equal(existsSync(join(dir, "findings")), true);
    const config = await readConfig(dir);
    assert.deepEqual(config.focus, DEFAULT_FOCUS);
    assert.match(config.needs, /local 3D workspace/);
    writeFileSync(join(dir, "focus.md"), "my topic\n");
    writeFileSync(join(dir, "office-needs.md"), "my needs\n");
    await ensureResearchLayout(dir);
    assert.deepEqual(await readConfig(dir), { focus: ["my topic"], needs: "my needs" });
  });

  it("reads lines leniently: bullets, headings and blanks are dropped, and the caps hold", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "focus.md"), `# Focus\n\n- one\n* two\nthree‮\n${"x".repeat(150)}\n` + Array.from({ length: 30 }, (_, i) => `t${i}`).join("\n"));
    writeFileSync(join(dir, "office-needs.md"), "n".repeat(9000));
    const c = await readConfig(dir);
    assert.deepEqual(c.focus.slice(0, 3), ["one", "two", "three"]);
    assert.equal(c.focus.length, 20);
    assert.equal(c.focus[3]?.length, 100);
    assert.equal(c.needs.length, 4000);
  });

  it("writes both notes atomically and reads them back", async () => {
    const dir = tmp();
    await writeConfig(dir, { focus: ["a topic", "another"], needs: "Line one\nLine two\n\n" });
    assert.equal(readFileSync(join(dir, "focus.md"), "utf8"), "a topic\nanother\n");
    assert.equal(readFileSync(join(dir, "office-needs.md"), "utf8"), "Line one\nLine two\n");
    assert.deepEqual(readdirSync(dir).sort(), ["focus.md", "office-needs.md"]);
    assert.deepEqual(await readConfig(dir), { focus: ["a topic", "another"], needs: "Line one\nLine two" });
  });

  it("never writes outside the research folder: a note that is a link is replaced, not followed", async (t) => {
    const dir = tmp();
    const outside = join(tmp(), "target.txt");
    writeFileSync(outside, "untouched");
    try {
      symlinkSync(outside, join(dir, "focus.md"), "file");
      symlinkSync(outside, join(dir, "office-needs.md"), "file");
    } catch {
      return t.skip("file links are not allowed on this machine");
    }
    assert.deepEqual(await readConfig(dir), { focus: [], needs: "" }, "a link to outside reads as empty");
    await writeConfig(dir, { focus: ["x"], needs: "y" });
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    assert.equal(readFileSync(join(dir, "focus.md"), "utf8"), "x\n");
  });
});
