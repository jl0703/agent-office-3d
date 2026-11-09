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
    assert.deepEqual(parseRoute("#/finds/demo-skills-pack"), { page: "find", id: "demo-skills-pack" });
    assert.deepEqual(parseRoute("#/settings"), { page: "settings" });
    assert.deepEqual(parseRoute("#/settings/x"), { page: "office" });
    assert.deepEqual(parseRoute("#/tasks"), { page: "tasks" });
    assert.deepEqual(parseRoute("#/tasks/x"), { page: "office" });
    assert.deepEqual(parseRoute("#/skills/clean-code"), { page: "item", kind: "skills", name: "clean-code" });
    assert.deepEqual(parseRoute("#/mcp/claude.ai%20Notion"), { page: "item", kind: "mcp", name: "claude.ai Notion" });
    for (const bad of ["#/nope", "#/skills/a/b", "#/skills/%E0%A4%A", "#/skills/..%2Fx", "#/skills/%0Ax", "#/skills/" + "x".repeat(61), "#/finds", "#/finds/", "#/finds/Bad_Id", "#/finds/a/b", "#/finds/..%2Fx", "#/finds/" + "a".repeat(81)]) {
      assert.deepEqual(parseRoute(bad), { page: "office" }, bad);
    }
  });

  it("builds addresses that parse back to the same route", () => {
    for (const hash of ["#/", "#/settings", "#/tasks", "#/finds/some-find", "#/skills", "#/mcp/claude.ai%20Notion", "#/agents/code-reviewer"]) {
      assert.equal(hrefFor(parseRoute(hash)), hash);
    }
  });
});
