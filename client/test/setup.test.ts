import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addSkill, demoSetup, describeServer, getSetup, matches, removeSkill, SKILL_NAME } from "../src/setup.ts";

const fake = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Pick<Response, "ok" | "status" | "json">;

describe("sidebar data", () => {
  it("reads skills and servers, drops odd rows, and gives null for a bad answer", async () => {
    const got = await getSetup(
      fake(200, {
        skills: [{ name: "a", description: "d" }, { name: 5 }, "x"],
        mcp: [{ name: "s", type: "stdio", command: "node", argCount: 2, envCount: 1, hasHeaders: false }, { name: "t", type: "weird" }, { name: "u", type: "http", host: "h.example", hasHeaders: true }],
      }),
    );
    assert.deepEqual(got?.skills, [{ name: "a", description: "d", added: false }]);
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
