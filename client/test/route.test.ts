import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hrefFor, parseRoute } from "../src/route.ts";

describe("routes", () => {
  it("knows the office, the three lists and one item, and falls back to the office for anything else", () => {
    assert.deepEqual(parseRoute(""), { page: "office" });
    assert.deepEqual(parseRoute("#/"), { page: "office" });
    assert.deepEqual(parseRoute("#/skills"), { page: "list", kind: "skills" });
    assert.deepEqual(parseRoute("#/mcp/"), { page: "list", kind: "mcp" });
    assert.deepEqual(parseRoute("#/agents"), { page: "list", kind: "agents" });
    assert.deepEqual(parseRoute("#/skills/clean-code"), { page: "item", kind: "skills", name: "clean-code" });
    assert.deepEqual(parseRoute("#/mcp/claude.ai%20Notion"), { page: "item", kind: "mcp", name: "claude.ai Notion" });
    for (const bad of ["#/nope", "#/skills/a/b", "#/skills/%E0%A4%A", "#/skills/..%2Fx", "#/skills/%0Ax", "#/skills/" + "x".repeat(61)]) {
      assert.deepEqual(parseRoute(bad), { page: "office" }, bad);
    }
  });

  it("builds addresses that parse back to the same route", () => {
    for (const hash of ["#/", "#/skills", "#/mcp/claude.ai%20Notion", "#/agents/code-reviewer"]) {
      assert.equal(hrefFor(parseRoute(hash)), hash);
    }
  });
});
