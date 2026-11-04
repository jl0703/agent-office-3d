import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanTmp, freshOnly, KEEP_MS, loadStore, MAX_STORED, saveStore, STORE_FILE } from "../src/managedStore.ts";
import { storedWorker } from "./fakeQuery.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "store-"));
  dirs.push(d);
  return d;
};
const file = (dir: string) => join(dir, STORE_FILE);
const write = (dir: string, value: unknown) => writeFileSync(file(dir), typeof value === "string" ? value : JSON.stringify(value));
const good = (workers: unknown[]) => ({ version: 1, workers });

describe("managed worker file", () => {
  it("gives nothing when there is no file, and reads back what was saved", async () => {
    const dir = tmp();
    assert.deepEqual(await loadStore(dir), []);
    const w = storedWorker("a-1", { pid: 123, processName: "node", pidStartedAt: 5, costUsdTotal: 1.25 });
    await saveStore(dir, [w]);
    assert.deepEqual(await loadStore(dir), [w]);
    assert.deepEqual(readdirSync(dir), [STORE_FILE], "no temporary file is left");
  });

  it("is complete or unchanged when the write is interrupted", async () => {
    const dir = tmp();
    const before = [storedWorker("keep-me")];
    await saveStore(dir, before);
    const original = readFileSync(file(dir), "utf8");
    const dying = {
      rename: async () => assert.fail("must not be reached"),
      // Writes half of the data, then fails, like a crash in the middle of a write.
      writeFile: (async (path: string, data: string) => {
        await writeFile(path, data.slice(0, data.length / 2));
        throw new Error("disk gone");
      }) as unknown as typeof writeFile,
    };
    await assert.rejects(saveStore(dir, [storedWorker("new-one")], dying as never), /disk gone/);
    assert.equal(readFileSync(file(dir), "utf8"), original);
    assert.deepEqual(readdirSync(dir), [STORE_FILE], "the half-written temporary file is removed");
    assert.deepEqual(await loadStore(dir), before);
  });

  it("ignores a temporary file left behind by a crash, and removes it at startup", async () => {
    const dir = tmp();
    await saveStore(dir, [storedWorker("a")]);
    writeFileSync(join(dir, `${STORE_FILE}.999.tmp`), '{"version":1,"work');
    assert.equal((await loadStore(dir)).length, 1);
    assert.equal(readdirSync(dir).length, 2, "reading leaves other files alone");
    await cleanTmp(dir);
    assert.deepEqual(readdirSync(dir), [STORE_FILE]);
  });

  it("sets a damaged or unreadable file aside and starts empty", async () => {
    const cases: [string, unknown][] = [
      ["not json", "{nope"],
      ["empty", ""],
      ["array", "[]"],
      ["old version", { version: 0, workers: [] }],
      ["future version", { version: 2, workers: [] }],
      ["extra field", { version: 1, workers: [], extra: true }],
      ["worker with extra field", good([{ ...storedWorker("a"), run: "calc.exe" }])],
    ];
    for (const [name, content] of cases) {
      const dir = tmp();
      write(dir, content);
      assert.deepEqual(await loadStore(dir), [], name);
      assert.deepEqual(readdirSync(dir), [`${STORE_FILE}.bad`], name);
    }
  });

  it("refuses values that look like commands or are not sane, without using them", async () => {
    const bad: Record<string, object> = {
      "id with a path": { id: "../../etc/passwd" },
      "id with a command": { id: "a; calc" },
      "empty id": { id: "" },
      "text pid": { pid: "1; calc", processName: "node", pidStartedAt: 1 },
      "negative pid": { pid: -5, processName: "node", pidStartedAt: 1 },
      "fractional pid": { pid: 1.5, processName: "node", pidStartedAt: 1 },
      "huge pid": { pid: 2 ** 40, processName: "node", pidStartedAt: 1 },
      "negative cost": { costUsdTotal: -1 },
      "text cost": { costUsdTotal: "5" },
      "long task": { task: "x".repeat(201) },
      "no folder": { cwd: "" },
    };
    for (const [name, over] of Object.entries(bad)) {
      const dir = tmp();
      write(dir, good([{ ...storedWorker("ok"), ...over }]));
      assert.deepEqual(await loadStore(dir), [], name);
      assert.ok(readdirSync(dir).includes(`${STORE_FILE}.bad`), name);
    }
  });

  it("refuses a file with more workers than allowed", async () => {
    const dir = tmp();
    write(dir, good(Array.from({ length: MAX_STORED + 1 }, (_, i) => storedWorker(`w-${i}`))));
    assert.deepEqual(await loadStore(dir), []);
  });

  it("drops workers older than 24 hours, and keeps only the newest 50 when saving", async () => {
    const dir = tmp();
    const now = Date.now();
    await saveStore(dir, [storedWorker("old", { updatedAt: now - KEEP_MS - 1000 }), storedWorker("fresh", { updatedAt: now - 1000 })]);
    assert.deepEqual(freshOnly(await loadStore(dir), now).map((w) => w.id), ["fresh"]);
    const many = Array.from({ length: MAX_STORED + 5 }, (_, i) => storedWorker(`w-${i}`, { updatedAt: now - i * 1000 }));
    await saveStore(dir, many);
    const kept = await loadStore(dir);
    assert.equal(kept.length, MAX_STORED);
    assert.ok(kept.some((w) => w.id === "w-0") && !kept.some((w) => w.id === `w-${MAX_STORED + 4}`));
  });
});
