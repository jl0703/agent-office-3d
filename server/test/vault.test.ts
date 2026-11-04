import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { VaultInfo } from "../../shared/vault.ts";
import { startServer, type RunningServer } from "../src/app.ts";
import { createVault } from "../src/vault.ts";
import { loginTo, send } from "./helpers.ts";

const SECRET = "TOP-SECRET-BODY-TEXT-9731";
const temps: string[] = [];
const servers: RunningServer[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "office-vault-"));
  temps.push(d);
  return d;
}

function note(root: string, rel: string, body = "", ageSeconds = 0) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  const t = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, t, t);
}

async function api(vaultDir: string | undefined, path = "/api/vault") {
  const staticDir = tempDir();
  const srv = await startServer({ port: 0, staticDir, ...(vaultDir ? { vaultDir } : {}) });
  servers.push(srv);
  const { host, cookie } = await loginTo(srv);
  const get = async (p = path) => {
    const r = await send(srv.port, p, { headers: { host, cookie } });
    return { status: r.status, raw: r.body, info: JSON.parse(r.body) as VaultInfo };
  };
  return { srv, host, cookie, get };
}

function connected(info: VaultInfo) {
  assert.equal(info.connected, true);
  if (!info.connected) throw new Error("unreachable");
  return info;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("GET /api/vault access", () => {
  it("answers connected:false with 200 when no vault is set or the folder is invalid", async () => {
    for (const dir of [undefined, join(tempDir(), "missing"), "relative/path"]) {
      const { get } = await api(dir);
      const r = await get();
      assert.equal(r.status, 200);
      assert.deepEqual(r.info, { connected: false });
    }
  });

  it("needs the session cookie and an allowed Host", async () => {
    const root = tempDir();
    note(root, "A.md");
    const { srv, host, cookie } = await api(root);
    assert.equal((await send(srv.port, "/api/vault", { headers: { host } })).status, 403);
    assert.equal((await send(srv.port, "/api/vault", { headers: { host: "evil.example", cookie } })).status, 403);
  });

  it("takes the folder only from the server setting, never from the request", async () => {
    const root = tempDir();
    const other = tempDir();
    note(other, "Other.md");
    const { get } = await api(root);
    const r = await get(`/api/vault?dir=${encodeURIComponent(other)}&vaultDir=${encodeURIComponent(other)}`);
    assert.equal(connected(r.info).noteCount, 0);
  });
});

describe("vault scan", () => {
  it("returns titles, links (alias, heading, case-insensitive) and the 5 newest notes, never bodies", async () => {
    const root = tempDir();
    note(root, "Alpha.md", `${SECRET} [[beta|the b]] [[Gamma#Intro]] [[nowhere]]`, 600);
    note(root, "Beta.md", `${SECRET} [[ALPHA]]`, 500);
    note(root, "sub/Gamma.md", SECRET, 400);
    for (let i = 1; i <= 5; i++) note(root, `new/N${i}.md`, SECRET, i);
    note(root, "readme.txt", SECRET);
    const { get } = await api(root);
    const r = await get();
    const v = connected(r.info);
    assert.equal(v.name, basename(root));
    assert.equal(v.noteCount, 8);
    assert.deepEqual(
      v.recent.map((n) => n.path),
      ["new/N1.md", "new/N2.md", "new/N3.md", "new/N4.md", "new/N5.md"],
    );
    assert.equal(v.recent[0]?.title, "N1");
    const links = v.links.map((l) => `${l.from}>${l.to}`).sort();
    assert.deepEqual(links, ["Alpha.md>Beta.md", "Alpha.md>sub/Gamma.md", "Beta.md>Alpha.md"]);
    // The most linked notes come first among the nodes.
    assert.equal(v.nodes[0]?.id, "Alpha.md");
    assert.ok(!r.raw.includes(SECRET), "note body leaked into the response");
    assert.ok(!r.raw.includes("nowhere"), "unresolved link text leaked");
    const again = await get("/api/vault?refresh=1");
    assert.ok(!again.raw.includes(SECRET));
  });

  it("skips hidden folders and non-markdown files", async () => {
    const root = tempDir();
    note(root, "Keep.md");
    for (const h of [".obsidian", ".trash", ".git", ".other"]) note(root, `${h}/Hidden.md`);
    note(root, "docs/.hidden/Deep.md");
    note(root, ".dotfile.md");
    note(root, "image.png");
    const v = connected((await (await api(root)).get()).info);
    assert.equal(v.noteCount, 1);
    assert.deepEqual(v.nodes, [{ id: "Keep.md", title: "Keep" }]);
  });

  it("does not follow links that leave the vault", async () => {
    const outside = tempDir();
    note(outside, "Outside.md", `${SECRET} [[Inside]]`);
    const root = tempDir();
    note(root, "Inside.md", "[[Outside]]");
    symlinkSync(outside, join(root, "escape"), "junction");
    try {
      symlinkSync(join(outside, "Outside.md"), join(root, "Linked.md"), "file");
    } catch {
      // creating file links needs a privilege on Windows; the folder link above covers the case
    }
    const r = await (await api(root)).get();
    const v = connected(r.info);
    assert.equal(v.noteCount, 1);
    assert.deepEqual(v.links, []);
    assert.ok(!r.raw.includes("Outside"));
    assert.ok(!r.raw.includes(SECRET));
  });

  it("follows a link that stays inside the vault", async () => {
    const root = tempDir();
    note(root, "real/Doc.md");
    symlinkSync(join(root, "real"), join(root, "alias"), "junction");
    const v = connected((await (await api(root)).get()).info);
    assert.equal(v.noteCount, 1); // reached once, not twice
  });

  it("does not follow a link into a hidden folder inside the vault", async () => {
    const root = tempDir();
    note(root, "Keep.md");
    note(root, ".trash/Deleted.md");
    symlinkSync(join(root, ".trash"), join(root, "innocent"), "junction");
    const v = connected((await (await api(root)).get()).info);
    assert.equal(v.noteCount, 1);
  });

  it("keeps at most 500 link targets per note, and stays fast on a note full of links", async () => {
    const root = tempDir();
    note(root, "Src.md", Array.from({ length: 600 }, (_, i) => `[[T${i}]]`).join(" "));
    // The newest notes are the ones past the 500th target, so only the cap keeps them out.
    for (let i = 0; i < 600; i++) note(root, `T${i}.md`, "", i >= 500 ? 1 : 1000);
    note(root, "Spam.md", "[[x]]".repeat(50_000)); // about 250 KB
    const start = Date.now();
    const v = connected((await (await api(root)).get()).info);
    assert.ok(Date.now() - start < 1000);
    assert.ok(v.links.length > 0);
    assert.ok(!v.nodes.some((n) => /^T5\d\d$/.test(n.title)), "a target past the 500th became a node");
  });

  it("visits at most 5000 folders", async () => {
    const root = tempDir();
    for (let i = 0; i < 5100; i++) note(root, `d${String(i).padStart(4, "0")}/N.md`);
    const v = connected((await (await api(root)).get()).info);
    assert.ok(v.noteCount < 5000, `scanned ${v.noteCount} notes`);
  });

  it("ignores links in files over 256 KB", async () => {
    const root = tempDir();
    note(root, "Big.md", "[[Small]]" + " ".repeat(256 * 1024 + 1));
    note(root, "Small.md");
    note(root, "Ok.md", "[[Small]]");
    const v = connected((await (await api(root)).get()).info);
    assert.equal(v.noteCount, 2 + 1);
    assert.deepEqual(v.links, [{ from: "Ok.md", to: "Small.md" }]);
  });

  it("caps nodes at 200 and links at 1000, keeping the most linked notes", async () => {
    const root = tempDir();
    const hubs = Array.from({ length: 60 }, (_, i) => `Hub${i}`);
    for (const h of hubs) note(root, `${h}.md`, hubs.map((o) => `[[${o}]]`).join(" "));
    for (let i = 0; i < 240; i++) note(root, `Leaf${i}.md`, "");
    const v = connected((await (await api(root)).get()).info);
    assert.equal(v.noteCount, 300);
    assert.equal(v.nodes.length, 200);
    assert.equal(v.links.length, 1000);
    assert.ok(hubs.every((h) => v.nodes.some((n) => n.title === h)));
    const ids = new Set(v.nodes.map((n) => n.id));
    assert.ok(v.links.every((l) => ids.has(l.from) && ids.has(l.to)));
  });

  it("scans 5000 notes (the cap) in under 2 s without starving the event loop", async () => {
    const root = tempDir();
    for (let i = 0; i < 5200; i++) {
      writeFileSync(join(root, `Note ${i}.md`), `link to [[Note ${(i + 1) % 5200}]] and [[Note ${(i * 7) % 5200}|x]]`);
    }
    const vault = createVault(root);
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    const start = Date.now();
    const info = connected(await vault.get(false));
    const took = Date.now() - start;
    clearInterval(timer);
    assert.equal(info.noteCount, 5000);
    assert.ok(took < 2000, `scan took ${took} ms`);
    assert.ok(worst < 250, `event loop stalled for ${worst} ms`);
  });
});

describe("vault cache", () => {
  it("rescans after 30 s, and on request at most once every 5 s", async () => {
    const root = tempDir();
    note(root, "A.md");
    let clock = 1_000_000;
    const vault = createVault(root, { now: () => clock });
    const count = async (refresh: boolean) => connected(await vault.get(refresh)).noteCount;
    assert.equal(await count(false), 1);
    note(root, "B.md");
    assert.equal(await count(false), 1, "served from the cache");
    clock += 4000;
    assert.equal(await count(true), 1, "refresh within 5 s is ignored");
    clock += 1500;
    assert.equal(await count(true), 2, "refresh after 5 s rescans");
    note(root, "C.md");
    clock += 29_000;
    assert.equal(await count(false), 2);
    clock += 2000;
    assert.equal(await count(false), 3, "cache expires after 30 s");
  });

  it("limits ?refresh=1 over HTTP", async () => {
    const root = tempDir();
    note(root, "A.md");
    const { get } = await api(root);
    assert.equal(connected((await get()).info).noteCount, 1);
    note(root, "B.md");
    assert.equal(connected((await get("/api/vault?refresh=1")).info).noteCount, 1);
  });
});
