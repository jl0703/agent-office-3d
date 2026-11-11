import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addPerson, belowOf, chainOf, demoTeam, getTeam, layersOf, orgOf, removePerson, reportsLine, roleOf, TEAM_FAILURES, type Person } from "../src/team.ts";

const team = demoTeam();
const named = (n: string) => team.find((p) => p.name === n)!;
const reply = (status: number, body: unknown) => async () => ({ ok: status < 300, status, json: async () => body });

describe("team: reading the line of reporting", () => {
  it("says who a person reports to, up the line", () => {
    assert.equal(reportsLine(team, named("Riley").id), "Reports to Sam, then Alex");
    assert.equal(reportsLine(team, named("Sam").id), "Reports to Alex");
    assert.equal(reportsLine(team, named("Alex").id), "Top of the team");
    assert.deepEqual(chainOf(team, named("Morgan").id).map((p) => p.name), ["Jordan", "Alex"]);
  });

  it("finds everyone below a person, and survives a loop in bad data", () => {
    assert.deepEqual([...belowOf(team, named("Sam").id)].sort(), [named("Riley").id, named("Casey").id].sort());
    const loop = [{ id: "a", name: "A", role: "r", brief: "", reportsTo: "b" }, { id: "b", name: "B", role: "r", brief: "", reportsTo: "a" }];
    assert.equal(chainOf(loop, "a").length <= 2, true);
    assert.equal(belowOf(loop, "a").size, 2);
    assert.equal(orgOf([{ id: "a", name: "A", role: "r", brief: "", reportsTo: "gone" }]).length, 1, "a person whose manager is missing from the list is still shown");
  });

  it("builds the org tree from the top down", () => {
    const [top] = orgOf(team);
    assert.equal(top?.person.name, "Alex");
    assert.deepEqual(top?.reports.map((n) => n.person.name), ["Sam", "Jordan"]);
    assert.deepEqual(top?.reports[0]?.reports.map((n) => n.person.name), ["Riley", "Casey"]);
  });
});

describe("team: calls", () => {
  it("reads the team and refuses an answer in a wrong shape", async () => {
    assert.deepEqual(await getTeam(reply(200, { people: team })), team);
    assert.equal(await getTeam(reply(200, { people: [{ id: 1 }] })), null);
    assert.equal(await getTeam(reply(404, {})), null);
  });

  it("sends confirm with every change and turns a refusal into a plain message", async () => {
    let sent = "";
    const ok = await addPerson({ name: "N", role: "R", brief: "", reportsTo: null }, async (_u, init) => ((sent = String(init?.body)), { ok: true, status: 200, json: async () => ({ people: team }) }));
    assert.ok(ok.ok);
    assert.equal(JSON.parse(sent).confirm, true);
    const refused = await removePerson("x", reply(409, { reason: "is_top" }));
    assert.deepEqual(refused, { ok: false, message: TEAM_FAILURES["is_top"] });
    const expired = await removePerson("x", reply(403, { error: "origin" }));
    assert.ok(!expired.ok && /session/.test(expired.message));
  });
});

describe("team: the role of an agent", () => {
  it("finds the person an agent works as, with the managers above them, and nothing for an agent with no role", () => {
    const found = roleOf({ personId: named("Riley").id }, team);
    assert.equal(found?.person.role, "Frontend Developer");
    assert.deepEqual(found?.managers, ["Sam", "Alex"]);
    assert.equal(found?.reportsTo, "Reports to Sam, then Alex");
    assert.equal(roleOf({}, team), null, "a session you started yourself has no role");
    assert.equal(roleOf({ personId: "000000000099" }, team), null, "a person who left the team");
    assert.deepEqual(roleOf({ personId: named("Alex").id }, team)?.managers, []);
  });
});

describe("the org chart in layers", () => {
  const person = (id: string, reportsTo: string | null): Person => ({ id, name: id, role: "r", brief: "", reportsTo });

  it("puts the top person on level 1 and everyone who reports to a person one level below them", () => {
    const layers = layersOf(orgOf(demoTeam()));
    assert.deepEqual(layers.map((l) => [l.level, l.people.map((p) => p.name)]), [[1, ["Alex"]], [2, ["Sam", "Jordan"]], [3, ["Riley", "Casey", "Morgan"]]]);
  });

  it("counts every person once, and has as many layers as the longest reporting line", () => {
    const team = [person("a", null), person("b", "a"), person("c", "b"), person("d", "c"), person("e", "a"), person("f", "d")];
    const layers = layersOf(orgOf(team));
    assert.equal(layers.length, 5);
    assert.equal(layers.flatMap((l) => l.people).length, team.length);
    assert.deepEqual(layers.map((l) => l.people.length), [1, 2, 1, 1, 1]);
  });

  it("has no layers for no team, and puts people whose manager is missing on the first layer", () => {
    assert.deepEqual(layersOf([]), []);
    const layers = layersOf(orgOf([person("x", "gone"), person("y", "x")]));
    assert.deepEqual(layers.map((l) => l.people.map((p) => p.id)), [["x"], ["y"]]);
  });
});
