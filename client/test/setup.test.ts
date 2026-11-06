import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demoSetup, describeServer, getSetup, matches } from "../src/setup.ts";

const fake = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Pick<Response, "ok" | "status" | "json">;

describe("sidebar data", () => {
  it("reads skills and servers, drops odd rows, and gives null for a bad answer", async () => {
    const got = await getSetup(
      fake(200, {
        skills: [{ name: "a", description: "d" }, { name: 5 }, "x"],
        mcp: [{ name: "s", type: "stdio", command: "node", argCount: 2, envCount: 1, hasHeaders: false }, { name: "t", type: "weird" }, { name: "u", type: "http", host: "h.example", hasHeaders: true }],
      }),
    );
    assert.deepEqual(got?.skills, [{ name: "a", description: "d" }]);
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
