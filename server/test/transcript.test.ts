import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLine, type Fact } from "../src/transcript.ts";

const line = (o: unknown) => JSON.stringify(o);
const facts = (o: unknown): Fact[] => {
  const r = parseLine(line(o));
  assert.ok(r.ok);
  return r.facts;
};

describe("transcript parser", () => {
  it("turns a tool call into a start fact with a short summary", () => {
    const f = facts({
      type: "assistant",
      timestamp: "2026-11-03T10:00:00.000Z",
      message: {
        content: [
          { type: "text", text: "Editing now" },
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "C:\\proj\\src\\app.ts", old_string: "SECRET_OLD", new_string: "SECRET_NEW" } },
        ],
      },
    });
    const start = f.find((x) => x.kind === "tool_start");
    assert.deepEqual(start, { kind: "tool_start", id: "t1", name: "Edit", summary: "Edit app.ts" });
    assert.ok(f.some((x) => x.kind === "event"));
    assert.ok(!JSON.stringify(f).includes("SECRET"));
  });

  it("never puts shell command text in a summary, only the description", () => {
    const withDesc = facts({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "curl -H 'Authorization: Bearer SECRET'", description: "Fetch the page" } }] },
    });
    const without = facts({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "echo SECRET" } }] },
    });
    assert.ok(JSON.stringify(withDesc).includes("Bash Fetch the page"));
    assert.ok(!JSON.stringify(withDesc).includes("SECRET"));
    assert.ok(!JSON.stringify(without).includes("SECRET"));
    assert.ok(without.some((x) => x.kind === "tool_start" && x.summary === "Bash"));
  });

  it("drops the query string and credentials from a fetched URL", () => {
    const f = facts({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "u", name: "WebFetch", input: { url: "https://user:pw@example.com/a/b?token=SECRET#x" } }] },
    });
    const start = f.find((x) => x.kind === "tool_start");
    assert.ok(start && start.kind === "tool_start");
    assert.equal(start.summary, "WebFetch example.com/a/b");
    assert.ok(!JSON.stringify(f).includes("SECRET"));
    assert.ok(!JSON.stringify(f).includes("pw"));
  });

  it("turns a tool result into an end fact", () => {
    const f = facts({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "big output SECRET" }] } });
    assert.deepEqual(f.find((x) => x.kind === "tool_end"), { kind: "tool_end", id: "t1" });
    assert.ok(!JSON.stringify(f).includes("SECRET"));
  });

  it("reads a typed prompt as an event only", () => {
    assert.deepEqual(facts({ type: "user", message: { content: "do the thing" } }), [{ kind: "event" }]);
  });

  it("cleans and cuts the title and the last prompt to 200 characters", () => {
    const long = "word   ".repeat(100) + "\n\ttail";
    const title = facts({ type: "ai-title", aiTitle: "  My\n title  " });
    const prompt = facts({ type: "last-prompt", lastPrompt: long });
    assert.deepEqual(title, [{ kind: "title", text: "My title" }]);
    const p = prompt[0];
    assert.ok(p && p.kind === "prompt");
    assert.ok(p.text.length <= 200);
    assert.ok(!/[\n\t]/.test(p.text));
    assert.ok(p.text.endsWith("…"));
  });

  it("ignores a last-prompt line with no prompt", () => {
    assert.deepEqual(facts({ type: "last-prompt" }), []);
  });

  it("reads the timestamp and working folder", () => {
    const r = parseLine(line({ type: "assistant", timestamp: "2026-11-03T10:00:00.000Z", cwd: "C:\\a\\b", message: { content: [] } }));
    assert.ok(r.ok);
    assert.equal(r.ts, Date.parse("2026-11-03T10:00:00.000Z"));
    assert.equal(r.cwd, "C:\\a\\b");
    const none = parseLine(line({ type: "assistant", timestamp: "garbage", message: { content: [] } }));
    assert.ok(none.ok && none.ts === null && none.cwd === null);
  });

  it("flags malformed input instead of throwing", () => {
    for (const raw of ["", "{not json", "null", "42", '"str"', "[]", "{}", '{"type":7}']) {
      const r = parseLine(raw);
      assert.equal(r.ok, false, raw);
    }
  });

  it("ignores known internal types silently and reports unknown ones", () => {
    const quiet = parseLine(line({ type: "api-request-blob", message: { content: [{ type: "text", text: "x" }] } }));
    assert.ok(quiet.ok && quiet.facts.length === 0 && quiet.unknownType === undefined);
    const odd = parseLine(line({ type: "brand-new-thing" }));
    assert.ok(odd.ok && odd.unknownType === "brand-new-thing");
  });

  it("cuts an unknown type name down, so a hostile log cannot fill memory with it", () => {
    const r = parseLine(line({ type: "x".repeat(100_000) }));
    assert.ok(r.ok && r.unknownType !== undefined && r.unknownType.length <= 64);
  });

  it("survives odd block shapes", () => {
    const f = facts({
      type: "assistant",
      message: { content: [null, 5, "x", { type: "tool_use" }, { type: "tool_use", id: 3, name: "X" }, { type: "tool_use", id: "ok", name: "Read", input: null }] },
    });
    assert.deepEqual(f.filter((x) => x.kind === "tool_start"), [{ kind: "tool_start", id: "ok", name: "Read", summary: "Read" }]);
  });
});
