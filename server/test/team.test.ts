import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { createRegistry } from "../src/registry.ts";
import { realOps } from "../src/managedStore.ts";
import { AVATAR_KEYS, isAvatar } from "../../shared/avatar.ts";
import { chainOf, checkTeam, createTeamStore, MAX_PEOPLE, PersonInput, TEAM_FILE, type Person } from "../src/team.ts";
import { loginTo, send } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "team-"));
  dirs.push(d);
  return d;
};
const person = (id: string, reportsTo: string | null, name = id): Person => ({ id: id.padEnd(12, "0"), name, role: "Dev", brief: "", reportsTo: reportsTo === null ? null : reportsTo.padEnd(12, "0") });

describe("team: the rules for a whole team", () => {
  it("allows a tree with one person at the top, and refuses a missing manager, a loop, a second top and too deep a line", () => {
    assert.equal(checkTeam([person("a", null), person("b", "a"), person("c", "b")]), null);
    assert.equal(checkTeam([person("a", null), person("b", "x")]), "unknown_manager");
    assert.equal(checkTeam([person("a", "b"), person("b", "a")]), "cycle");
    assert.equal(checkTeam([person("a", null), person("b", null)]), "one_top");
    const line = ["a", "b", "c", "d", "e", "f", "g"].map((id, i, all) => person(id, i === 0 ? null : (all[i - 1] as string)));
    assert.equal(checkTeam(line), "too_deep");
    assert.equal(checkTeam(line.slice(0, 6)), null, "six levels is the limit");
    assert.equal(checkTeam([person("a", null), person("a", null)]), "invalid", "a repeated id");
    assert.equal(checkTeam(Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => person(String(i), null))), "too_many");
  });

  it("lists the line up from a person, nearest manager first", () => {
    const people = [person("a", null, "CEO"), person("b", "a", "Lead"), person("c", "b", "Dev")];
    assert.deepEqual(chainOf(people, "c".padEnd(12, "0")).map((p) => p.name), ["Lead", "CEO"]);
    assert.deepEqual(chainOf(people, "a".padEnd(12, "0")), []);
  });
});

describe("team: the store", () => {
  it("adds, updates and removes people, saves them, and reads them back after a restart", async () => {
    const dir = tmp();
    const store = createTeamStore(dir);
    const boss = await store.add({ name: "Alex", role: "CEO", brief: "Decide", reportsTo: null });
    assert.ok(boss.ok && boss.person);
    const lead = await store.add({ name: "Sam", role: "Lead", brief: "", reportsTo: boss.person.id });
    assert.ok(lead.ok && lead.person);
    const dev = await store.add({ name: "Riley", role: "Developer", brief: "", reportsTo: lead.person.id });
    assert.ok(dev.ok && dev.person);
    assert.equal((await store.add({ name: "Two", role: "CEO", brief: "", reportsTo: null })).ok, false, "only one at the top");
    assert.deepEqual(await store.update(dev.person.id, { reportsTo: dev.person.id }), { ok: false, code: "cycle" });
    assert.deepEqual(await store.update("0".repeat(12), { name: "x" }), { ok: false, code: "unknown_person" });
    const renamed = await store.update(dev.person.id, { role: "Frontend Developer" });
    assert.ok(renamed.ok && renamed.person?.role === "Frontend Developer");
    assert.deepEqual(await store.remove(boss.person.id), { ok: false, code: "is_top" });
    assert.deepEqual(await store.remove(lead.person.id, () => true), { ok: false, code: "busy" });
    const removed = await store.remove(lead.person.id);
    assert.ok(removed.ok);
    assert.equal(removed.people.find((p) => p.id === dev.person?.id)?.reportsTo, boss.person.id, "the removed person's reports move up");
    const again = await createTeamStore(dir).list();
    assert.deepEqual(again.map((p) => p.name).sort(), ["Alex", "Riley"]);
  });

  it("fills an empty team with the starter team once, and sets a damaged file aside as an empty team", async () => {
    const dir = tmp();
    const store = createTeamStore(dir);
    const made = await store.starter();
    assert.ok(made.ok);
    assert.equal(made.people.length, 6);
    assert.equal(checkTeam(made.people), null);
    assert.deepEqual(await store.starter(), { ok: false, code: "not_empty" });
    const broken = tmp();
    writeFileSync(join(broken, TEAM_FILE), '{"version":1,"people":[{"id":"nope"}]}');
    assert.deepEqual(await createTeamStore(broken).list(), []);
    assert.equal(existsSync(join(broken, `${TEAM_FILE}.bad`)), true);
  });

  it("refuses names with control or direction characters and an over-long brief, and keeps line breaks in a brief", () => {
    const ok = { name: " Alex ", role: "CEO", brief: "Line one\nLine two", reportsTo: null };
    const parsed = PersonInput.safeParse(ok);
    assert.ok(parsed.success && parsed.data.name === "Alex" && parsed.data.brief.includes('\n'), "names are trimmed and a brief keeps its line break");
    for (const bad of ["a\nb", "a\u202eb", "a\u2067b", "a\u200eb", "a\u2028b", "", " ", "x".repeat(61)]) assert.equal(PersonInput.safeParse({ ...ok, name: bad }).success, false, JSON.stringify(bad));
    assert.equal(PersonInput.safeParse({ ...ok, brief: "x".repeat(1501) }).success, false);
    assert.equal(PersonInput.safeParse({ ...ok, brief: "a\u0000b" }).success, false);
    assert.equal(PersonInput.safeParse({ ...ok, reportsTo: "../x" }).success, false);
  });
});

describe("team: the file", () => {
  it("keeps the old team when a save fails, and does not mistake a read error for an empty team", async () => {
    const dir = tmp();
    let failNext = false;
    const store = createTeamStore(dir, { writeFile: async (...a) => (failNext ? Promise.reject(new Error("disk")) : realOps.writeFile(...a)), rename: realOps.rename });
    const top = await store.add({ name: "Alex", role: "CEO", brief: "", reportsTo: null });
    assert.ok(top.ok && top.person);
    failNext = true;
    await assert.rejects(store.add({ name: "Sam", role: "Lead", brief: "", reportsTo: top.person.id }));
    assert.deepEqual((await store.list()).map((p) => p.name), ["Alex"], "the failed add left no trace");
    failNext = false;
    const unreadable = tmp();
    mkdirSync(join(unreadable, TEAM_FILE)); // a folder where the file should be: reading it fails with EISDIR, not ENOENT
    await assert.rejects(createTeamStore(unreadable).list());
    assert.equal(existsSync(join(unreadable, `${TEAM_FILE}.bad`)), false, "nothing was set aside");
  });

  it("runs calls one after another, so two adds at once both land", async () => {
    const store = createTeamStore(tmp());
    const top = await store.add({ name: "Alex", role: "CEO", brief: "", reportsTo: null });
    assert.ok(top.ok && top.person);
    const boss = top.person.id;
    await Promise.all(["A", "B", "C", "D"].map((name) => store.add({ name, role: "Dev", brief: "", reportsTo: boss })));
    assert.equal((await store.list()).length, 5);
  });
});

describe("team: the routes", () => {
  async function rig(withTeam = true) {
    const root = tmp();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const dataDir = join(root, "data");
    const srv = await startServer({ port: 0, staticDir, registry: createRegistry(), ...(withTeam ? { team: createTeamStore(dataDir) } : {}), log: () => {} });
    servers.push(srv);
    const auth = await loginTo(srv);
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
    const post = (path: string, body: unknown) => send(srv.port, path, { method: "POST", body: JSON.stringify(body), headers });
    const get = () => send(srv.port, "/api/team", { method: "GET", headers });
    return { post, get, dataDir, srv, auth };
  }
  const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

  it("adds, edits and removes only with confirm:true, and answers 400 or 409 with a reason", async () => {
    const r = await rig();
    assert.deepEqual(json(await r.get()), { people: [] });
    const input = { name: "Alex", role: "CEO", brief: "Decide", reportsTo: null };
    assert.equal((await r.post("/api/team/people", input)).status, 400, "no confirm");
    assert.equal((await r.post("/api/team/people", { ...input, confirm: true, extra: 1 })).status, 400, "unknown key");
    assert.equal((await r.post("/api/team/people", { ...input, name: "a\nb", confirm: true })).status, 400, "control character");
    const added = await r.post("/api/team/people", { ...input, confirm: true });
    assert.equal(added.status, 200);
    const boss = json(added)["person"] as Person;
    const second = await r.post("/api/team/people", { ...input, name: "Two", confirm: true });
    assert.deepEqual([second.status, json(second)], [409, { reason: "one_top" }]);
    const lead = json(await r.post("/api/team/people", { name: "Sam", role: "Lead", brief: "", reportsTo: boss.id, confirm: true }))["person"] as Person;
    const upd = await r.post("/api/team/people/update", { id: lead.id, role: "Engineering Lead", confirm: true });
    assert.equal((json(upd)["person"] as Person).role, "Engineering Lead");
    assert.equal((await r.post("/api/team/people/update", { id: lead.id, role: "x" })).status, 400, "no confirm");
    assert.equal((await r.post("/api/team/people/update", { id: "0".repeat(12), role: "x", confirm: true })).status, 404);
    assert.equal((await r.post("/api/team/people/remove", { id: boss.id })).status, 400, "no confirm");
    assert.deepEqual(json(await r.post("/api/team/people/remove", { id: boss.id, confirm: true })), { reason: "is_top" });
    const gone = await r.post("/api/team/people/remove", { id: lead.id, confirm: true });
    assert.equal((json(gone)["people"] as Person[]).length, 1);
    assert.equal(JSON.parse(readFileSync(join(r.dataDir, TEAM_FILE), "utf8")).people.length, 1);
  });

  it("sets up the starter team once, needs a session and a same-origin request, and is off without a store", async () => {
    const r = await rig();
    assert.equal((await r.post("/api/team/starter", {})).status, 400, "no confirm");
    const made = await r.post("/api/team/starter", { confirm: true });
    assert.equal((json(made)["people"] as Person[]).length, 6);
    assert.deepEqual([(await r.post("/api/team/starter", { confirm: true })).status], [409]);
    const nohdr = await send(r.srv.port, "/api/team", { method: "GET", headers: { host: r.auth.host } });
    assert.notEqual(nohdr.status, 200, "no session");
    const foreign = await send(r.srv.port, "/api/team/starter", { method: "POST", body: JSON.stringify({ confirm: true }), headers: { host: r.auth.host, cookie: r.auth.cookie, origin: "http://evil.example", "content-type": "application/json" } });
    assert.equal(foreign.status, 403);
    const off = await rig(false);
    assert.equal((await off.get()).status, 404);
  });
});

describe("team: the picture", () => {
  const look = { skin: 1, hair: 2, hairColor: 3, eyes: 0, mouth: 1, glasses: 2, outfit: 4, outfitColor: 7, background: 5 };

  it("accepts a look with every part inside its list, and refuses anything else", () => {
    const base = { name: "Alex", role: "CEO", brief: "", reportsTo: null };
    assert.ok(PersonInput.safeParse({ ...base, avatar: look }).success);
    assert.ok(PersonInput.safeParse(base).success, "a person with no look yet is fine");
    for (const [what, avatar] of Object.entries({
      "a part too high": { ...look, skin: 6 },
      "a negative part": { ...look, hair: -1 },
      "a fraction": { ...look, eyes: 0.5 },
      "text": { ...look, mouth: "1" },
      "a missing part": { ...look, outfit: undefined },
      "an extra key": { ...look, extra: 1 },
      "not an object": "skin",
    })) assert.equal(PersonInput.safeParse({ ...base, avatar }).success, false, what);
    assert.equal(AVATAR_KEYS.length, 9);
    assert.ok(isAvatar(look) && !isAvatar({ ...look, skin: 99 }) && !isAvatar(null));
  });

  it("keeps the look through add, update and a restart, and still reads a file written before looks existed", async () => {
    const dir = tmp();
    const store = createTeamStore(dir);
    const made = await store.add({ name: "Alex", role: "CEO", brief: "", reportsTo: null, avatar: look });
    assert.ok(made.ok && made.person);
    assert.deepEqual(made.person.avatar, look);
    const next = { ...look, hair: 5 };
    const updated = await store.update(made.person.id, { avatar: next });
    assert.ok(updated.ok && updated.person?.avatar?.hair === 5);
    assert.deepEqual((await createTeamStore(dir).list())[0]?.avatar, next);
    const old = tmp();
    writeFileSync(join(old, TEAM_FILE), JSON.stringify({ version: 1, people: [{ id: "a".repeat(12), name: "Old", role: "Dev", brief: "", reportsTo: null }] }));
    const [loaded] = await createTeamStore(old).list();
    assert.equal(loaded?.name, "Old");
    assert.equal(loaded?.avatar, undefined);
    const broken = tmp();
    writeFileSync(join(broken, TEAM_FILE), JSON.stringify({ version: 1, people: [{ id: "a".repeat(12), name: "Bad", role: "Dev", brief: "", reportsTo: null, avatar: { ...look, skin: 9 } }] }));
    assert.deepEqual(await createTeamStore(broken).list(), [], "an out-of-range look makes the file damaged, not half-read");
  });

  it("carries the look through the routes", async () => {
    const root = tmp();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, registry: createRegistry(), team: createTeamStore(join(root, "data")), log: () => {} });
    servers.push(srv);
    const auth = await loginTo(srv);
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
    const post = (path: string, body: unknown) => send(srv.port, path, { method: "POST", body: JSON.stringify(body), headers });
    const base = { name: "Alex", role: "CEO", brief: "", reportsTo: null, confirm: true };
    assert.equal((await post("/api/team/people", { ...base, avatar: { ...look, skin: 6 } })).status, 400);
    const made = JSON.parse((await post("/api/team/people", { ...base, avatar: look })).body) as { person: Person };
    assert.deepEqual(made.person.avatar, look);
    const upd = JSON.parse((await post("/api/team/people/update", { id: made.person.id, avatar: { ...look, hair: 0 }, confirm: true })).body) as { person: Person };
    assert.equal(upd.person.avatar?.hair, 0);
    assert.equal(upd.person.name, "Alex", "a change of look alone leaves the rest");
  });
});

describe("team: the department", () => {
  const base = { name: "Alex", role: "CEO", brief: "", reportsTo: null };

  it("is one short line, optional, and can be given, changed and taken away", async () => {
    assert.ok(PersonInput.safeParse({ ...base, department: "Engineering" }).success);
    assert.ok(PersonInput.safeParse({ ...base, department: null }).success, "null means none");
    assert.ok(PersonInput.safeParse(base).success);
    for (const bad of ["", " ", "a\nb", "x".repeat(41), "a\u202eb"]) assert.equal(PersonInput.safeParse({ ...base, department: bad }).success, false, JSON.stringify(bad));
    const store = createTeamStore(tmp());
    const made = await store.add({ ...base, department: "Engineering" });
    assert.ok(made.ok && made.person?.department === "Engineering");
    const moved = await store.update(made.person!.id, { department: "Quality" });
    assert.equal(moved.ok && moved.person?.department, "Quality");
    const none = await store.update(made.person!.id, { department: null });
    assert.ok(none.ok && none.person && !("department" in none.person), "taking it away leaves no key in the file");
    const again = await store.add({ name: "Sam", role: "Dev", brief: "", reportsTo: made.person!.id, department: null });
    assert.ok(again.ok && again.person && !("department" in again.person));
  });

  it("is in the starter team, in the routes, and a file written before departments existed still loads", async () => {
    const dir = tmp();
    const made = await createTeamStore(dir).starter();
    assert.ok(made.ok);
    assert.deepEqual([...new Set(made.people.map((p) => p.department))].sort(), ["Engineering", "Management", "Quality"]);
    assert.equal(made.people.find((p) => p.reportsTo === null)?.department, "Management");
    const old = tmp();
    writeFileSync(join(old, TEAM_FILE), JSON.stringify({ version: 1, people: [{ id: "a".repeat(12), name: "Old", role: "Dev", brief: "", reportsTo: null }] }));
    assert.equal((await createTeamStore(old).list())[0]?.department, undefined);
    const root = tmp();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, registry: createRegistry(), team: createTeamStore(join(root, "data")), log: () => {} });
    servers.push(srv);
    const auth = await loginTo(srv);
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
    const post = (path: string, body: unknown) => send(srv.port, path, { method: "POST", body: JSON.stringify(body), headers });
    const added = JSON.parse((await post("/api/team/people", { ...base, department: "Management", confirm: true })).body) as { person: Person };
    assert.equal(added.person.department, "Management");
    const cleared = JSON.parse((await post("/api/team/people/update", { id: added.person.id, department: null, confirm: true })).body) as { person: Person };
    assert.equal("department" in cleared.person, false);
    assert.equal((await post("/api/team/people/update", { id: added.person.id, department: "x".repeat(41), confirm: true })).status, 400);
  });
});
