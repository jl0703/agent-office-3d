import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { addedSkills, addSkill, dirsFor, MAX_COPY_FILES, MAX_SKILL_BYTES, removeSkill, validSkillText } from "../src/skillsManage.ts";
import { loginTo, send } from "./helpers.ts";

const dirs: string[] = [];
const servers: RunningServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "skills-")));
  dirs.push(d);
  return d;
};
const skill = (name: string, description = "Does a thing") => `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;

function rig() {
  const root = tmp();
  const skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "old-skill"), { recursive: true });
  writeFileSync(join(skillsDir, "old-skill", "SKILL.md"), skill("old-skill"));
  return { root, skillsDir, d: dirsFor(skillsDir, join(root, "data")) };
}

describe("skills: validation", () => {
  it("needs a header whose name is the folder name and a description, and refuses oversized or odd text", () => {
    assert.equal(validSkillText("a-b", skill("a-b")), true);
    assert.equal(validSkillText("a-b", skill("other")), false, "name differs");
    assert.equal(validSkillText("a-b", "---\nname: a-b\n---\n"), false, "no description");
    assert.equal(validSkillText("a-b", "no header"), false);
    assert.equal(validSkillText("a-b", skill("a-b", "x‮y")), false, "bidi character in the header");
    assert.equal(validSkillText("a-b", skill("a-b") + "x".repeat(MAX_SKILL_BYTES)), false);
    assert.equal(validSkillText("a-b", skill("a-b") + "\0"), false);
  });
});

describe("skills: adding", () => {
  it("creates a skill from pasted text, records it, and never replaces an existing one", async () => {
    const { skillsDir, d } = rig();
    assert.deepEqual(await addSkill(d, { name: "new-skill", content: skill("new-skill") }), { ok: true });
    assert.equal(readFileSync(join(skillsDir, "new-skill", "SKILL.md"), "utf8"), skill("new-skill"));
    assert.deepEqual([...(await addedSkills(d))], ["new-skill"]);
    assert.deepEqual(await addSkill(d, { name: "new-skill", content: skill("new-skill", "changed") }), { ok: false, code: "exists" });
    assert.deepEqual(await addSkill(d, { name: "old-skill", content: skill("old-skill", "changed") }), { ok: false, code: "exists" });
    assert.equal(readFileSync(join(skillsDir, "old-skill", "SKILL.md"), "utf8"), skill("old-skill"), "the old skill is untouched");
  });

  it("refuses bad names and bad text, and leaves no folder behind", async () => {
    const { skillsDir, d } = rig();
    for (const name of ["../escape", "Upper", "a b", "", "x".repeat(61)]) assert.deepEqual(await addSkill(d, { name, content: skill("x") }), { ok: false, code: "invalid_name" }, name);
    assert.deepEqual(await addSkill(d, { name: "mismatch", content: skill("other") }), { ok: false, code: "invalid_skill" });
    assert.deepEqual(await addSkill(d, { name: "huge", content: skill("huge") + "x".repeat(MAX_SKILL_BYTES) }), { ok: false, code: "too_big" });
    assert.deepEqual(await addSkill(d, { name: "empty" }), { ok: false, code: "invalid_skill" });
    assert.deepEqual(readdirSync(skillsDir), ["old-skill"]);
    assert.deepEqual([...(await addedSkills(d))], []);
  });

  it("copies a skill folder (without .git) and refuses a missing folder, one without SKILL.md and one with too many files", async () => {
    const { root, skillsDir, d } = rig();
    const source = join(root, "source");
    mkdirSync(join(source, "refs"), { recursive: true });
    mkdirSync(join(source, ".git"));
    writeFileSync(join(source, "SKILL.md"), skill("copied"));
    writeFileSync(join(source, "refs", "a.md"), "ref");
    writeFileSync(join(source, ".git", "config"), "skip");
    assert.deepEqual(await addSkill(d, { name: "copied", source }), { ok: true });
    assert.equal(readFileSync(join(skillsDir, "copied", "refs", "a.md"), "utf8"), "ref");
    assert.equal(existsSync(join(skillsDir, "copied", ".git")), false);
    assert.deepEqual(await addSkill(d, { name: "nope", source: join(root, "missing") }), { ok: false, code: "source_missing" });
    mkdirSync(join(root, "empty"));
    assert.deepEqual(await addSkill(d, { name: "nofile", source: join(root, "empty") }), { ok: false, code: "invalid_skill" });
    const big = join(root, "big");
    mkdirSync(big);
    writeFileSync(join(big, "SKILL.md"), skill("many"));
    for (let i = 0; i <= MAX_COPY_FILES; i++) writeFileSync(join(big, `f${i}.md`), "x");
    assert.deepEqual(await addSkill(d, { name: "many", source: big }), { ok: false, code: "too_big" });
    assert.equal(existsSync(join(skillsDir, "many")), false);
    assert.equal(existsSync(join(skillsDir, "nope")) || existsSync(join(skillsDir, "nofile")), false);
  });
});

describe("skills: removing", () => {
  it("moves only a skill added here into the trash, and refuses everything else", async () => {
    const { skillsDir, d } = rig();
    await addSkill(d, { name: "mine", content: skill("mine") });
    assert.deepEqual(await removeSkill(d, "old-skill"), { ok: false, code: "not_added" }, "a skill you did not add here");
    assert.deepEqual(await removeSkill(d, "../old-skill"), { ok: false, code: "invalid_name" });
    assert.deepEqual(await removeSkill(d, "mine", () => 123), { ok: true });
    assert.equal(existsSync(join(skillsDir, "mine")), false);
    assert.equal(readFileSync(join(d.trashDir, "mine-123", "SKILL.md"), "utf8"), skill("mine"), "moved, not deleted");
    assert.deepEqual([...(await addedSkills(d))], []);
    assert.deepEqual(await removeSkill(d, "mine"), { ok: false, code: "not_added" });
    assert.equal(existsSync(join(skillsDir, "old-skill")), true);
  });

  it("says not_found when an added skill's folder was already removed by hand", async () => {
    const { skillsDir, d } = rig();
    await addSkill(d, { name: "mine", content: skill("mine") });
    rmSync(join(skillsDir, "mine"), { recursive: true });
    assert.deepEqual(await removeSkill(d, "mine"), { ok: false, code: "not_found" });
  });
});

describe("skills: the routes", () => {
  it("add and remove need confirm:true and a signed-in page, and the list shows which skills were added here", async () => {
    const { root, skillsDir } = rig();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir, mcpFile: join(root, "none.json"), dataDir: join(root, "data") } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const headers = { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" };
    const post = (path: string, body: unknown, more: Record<string, string> = {}) => send(srv.port, path, { method: "POST", headers: { ...headers, ...more }, body: JSON.stringify(body) });
    const list = async () => JSON.parse((await send(srv.port, "/api/setup", { headers: { host: auth.host, cookie: auth.cookie } })).body) as { skills: { name: string; added: boolean }[]; canManage: boolean };

    assert.equal((await post("/api/setup/skills", { name: "web-skill", content: skill("web-skill") })).status, 400, "no confirm");
    assert.equal((await post("/api/setup/skills", { name: "web-skill", content: skill("web-skill"), confirm: false })).status, 400);
    assert.equal((await post("/api/setup/skills", { name: "web-skill", content: skill("web-skill"), source: "x", confirm: true })).status, 400, "both content and source");
    assert.equal(existsSync(join(skillsDir, "web-skill")), false);
    assert.equal((await post("/api/setup/skills", { name: "web-skill", content: skill("web-skill"), confirm: true }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await send(srv.port, "/api/setup/skills", { method: "POST", headers: { host: auth.host, "content-type": "application/json", origin: `http://${auth.host}` }, body: "{}" })).status, 403);

    assert.equal((await post("/api/setup/skills", { name: "web-skill", content: skill("web-skill"), confirm: true })).status, 201);
    const again = await post("/api/setup/skills", { name: "web-skill", content: skill("web-skill"), confirm: true });
    assert.deepEqual([again.status, JSON.parse(again.body)], [409, { reason: "exists" }]);
    const shown = await list();
    assert.equal(shown.canManage, true);
    assert.deepEqual(shown.skills.map((s) => [s.name, s.added]), [["old-skill", false], ["web-skill", true]]);

    const refused = await post("/api/setup/skills/remove", { name: "old-skill", confirm: true });
    assert.deepEqual([refused.status, JSON.parse(refused.body)], [409, { reason: "not_added" }]);
    assert.equal((await post("/api/setup/skills/remove", { name: "web-skill" })).status, 400, "no confirm");
    assert.equal((await post("/api/setup/skills/remove", { name: "web-skill", confirm: true })).status, 200);
    assert.deepEqual((await list()).skills.map((s) => s.name), ["old-skill"]);
  });

  it("answers 404 for add and remove when there is no data folder", async () => {
    const { root, skillsDir } = rig();
    const staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "x");
    const srv = await startServer({ port: 0, staticDir, setup: { skillsDir, mcpFile: join(root, "none.json") } });
    servers.push(srv);
    const auth = await loginTo(srv);
    const r = await send(srv.port, "/api/setup/skills", { method: "POST", headers: { host: auth.host, cookie: auth.cookie, origin: `http://${auth.host}`, "content-type": "application/json" }, body: JSON.stringify({ name: "x", content: skill("x"), confirm: true }) });
    assert.equal(r.status, 404);
  });
});
