import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addAgent, addMcp, addSkill, demoSetup, describeServer, getSetup, matches, parseEnv, parseLines, previewMcp, removeAgent, removeMcp, removeSkill, SKILL_NAME } from "../src/setup.ts";

const fake = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Pick<Response, "ok" | "status" | "json">;

describe("sidebar data", () => {
  it("reads skills and servers, drops odd rows, and gives null for a bad answer", async () => {
    const got = await getSetup(
      fake(200, {
        skills: [{ name: "a", description: "d" }, { name: 5 }, "x"],
        mcp: [{ name: "s", type: "stdio", command: "node", argCount: 2, envCount: 1, hasHeaders: false }, { name: "t", type: "weird" }, { name: "u", type: "http", host: "h.example", hasHeaders: true }],
      }),
    );
    assert.deepEqual(got?.skills, [{ name: "a", description: "d", added: false, modified: 0 }]);
    assert.deepEqual(got?.mcp.map((m) => m.name), ["s", "u"]);
    assert.equal(await getSetup(fake(403, {})), null);
    assert.equal(await getSetup(fake(200, { skills: [] })), null);
    assert.equal(await getSetup(async () => Promise.reject(new Error("offline"))), null);
  });

  it("describes a server without any secret and filters by text", () => {
    const [local, remote] = demoSetup().mcp;
    assert.equal(describeServer(local!), "runs node with 2 arguments; 1 environment value set");
    assert.equal(describeServer(remote!), "HTTP to mcp.example.com; headers set");
    assert.equal(matches("Clean Code", " clean"), true);
    assert.equal(matches("Clean Code", "zzz"), false);
  });
});

describe("adding and removing skills from the page", () => {
  const ok = () => {
    const calls: { path: string; body: unknown }[] = [];
    const fn = async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 201, json: async () => ({}) } as Pick<Response, "ok" | "status" | "json">;
    };
    return { fn, calls };
  };

  it("always sends confirm:true to the right route, with pasted text or a folder", async () => {
    const a = ok();
    assert.deepEqual(await addSkill({ name: "x", content: "---\n" }, a.fn), { ok: true });
    assert.deepEqual(a.calls[0], { path: "/api/setup/skills", body: { name: "x", content: "---\n", confirm: true } });
    const b = ok();
    await addSkill({ name: "x", source: "/tmp/s" }, b.fn);
    assert.deepEqual(b.calls[0]?.body, { name: "x", source: "/tmp/s", confirm: true });
    const c = ok();
    await removeSkill("x", c.fn);
    assert.deepEqual(c.calls[0], { path: "/api/setup/skills/remove", body: { name: "x", confirm: true } });
  });

  it("explains each refusal in plain words and checks names the same way as the server", async () => {
    for (const [status, body, word] of [[409, { reason: "exists" }, /already exists/], [400, { error: "invalid_skill" }, /header/], [413, { error: "too_big" }, /too big/], [409, { reason: "not_added" }, /added from this menu/], [500, { error: "failed" }, /Nothing was changed/]] as const) {
      const r = await addSkill({ name: "x", content: "c" }, fake(status, body));
      assert.equal(r.ok === false && word.test(r.message), true, JSON.stringify(body));
    }
    assert.deepEqual(["ok-name", "a", "Bad", "a b", "", "-x"].map((n) => SKILL_NAME.test(n)), [true, true, false, false, false, false]);
  });
});

describe("MCP servers from the page", () => {
  const sent = () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const fn = async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ command: "claude mcp add x" }) } as Pick<Response, "ok" | "status" | "json">;
    };
    return { fn, calls };
  };
  const input = { name: "x", transport: "stdio" as const, command: "npx", args: ["-y", "x"], env: { K: "v" } };

  it("previews without confirm, adds and removes with confirm, and returns the preview text", async () => {
    const a = sent();
    assert.deepEqual(await previewMcp(input, a.fn), { ok: true, command: "claude mcp add x" });
    assert.deepEqual(a.calls[0], { path: "/api/setup/mcp/preview", body: input });
    assert.equal("confirm" in (a.calls[0]?.body ?? {}), false);
    const b = sent();
    await addMcp(input, b.fn);
    assert.deepEqual(b.calls[0], { path: "/api/setup/mcp", body: { ...input, confirm: true } });
    const c = sent();
    await removeMcp("x", c.fn);
    assert.deepEqual(c.calls[0], { path: "/api/setup/mcp/remove", body: { name: "x", confirm: true } });
  });

  it("explains refusals and reads the text boxes", async () => {
    for (const [status, body, word] of [[409, { reason: "exists" }, /already exists/], [400, { error: "invalid_input" }, /Check the fields/], [500, { error: "failed" }, /claude command did not succeed/]] as const) {
      const r = await addMcp(input, fake(status, body));
      assert.equal(r.ok === false && word.test(r.message), true, JSON.stringify(body));
    }
    assert.deepEqual(parseLines("a\r\n\n  \nb\n"), ["a", "b"]);
    assert.deepEqual(parseEnv("A=1\nB=x=y\n"), { A: "1", B: "x=y" });
    assert.equal(parseEnv("novalue"), null);
    assert.equal(parseEnv("=x"), null);
  });
});

describe("agents from the page", () => {
  it("reads agents with their model and tools, drops odd rows, and uses the agents routes", async () => {
    const got = await getSetup(fake(200, { skills: [], mcp: [], agents: [{ name: "reviewer", description: "d", model: "sonnet", tools: "Read", added: true, modified: 5 }, { nope: 1 }, "x"], canManageAgents: true }));
    assert.deepEqual(got?.agents, [{ name: "reviewer", description: "d", model: "sonnet", tools: "Read", added: true, modified: 5 }]);
    assert.equal(got?.canManageAgents, true);
    assert.deepEqual((await getSetup(fake(200, { skills: [], mcp: [] })))?.agents, [], "an older server without agents still works");
    const calls: { path: string; body: unknown }[] = [];
    const rec = async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 201, json: async () => ({}) } as Pick<Response, "ok" | "status" | "json">;
    };
    await addAgent({ name: "x", content: "---" }, rec);
    await removeAgent("x", rec);
    assert.deepEqual(calls, [{ path: "/api/setup/agents", body: { name: "x", content: "---", confirm: true } }, { path: "/api/setup/agents/remove", body: { name: "x", confirm: true } }]);
  });
});
