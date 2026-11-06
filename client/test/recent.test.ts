import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadRecent, remember, RECENT_MAX } from "../src/recent.ts";

const memory = (initial?: string) => {
  let v = initial ?? null;
  return { getItem: () => v, setItem: (_k: string, s: string) => void (v = s) };
};

describe("recent starts", () => {
  it("puts the newest first, drops repeats and keeps only five", () => {
    const s = memory();
    for (let i = 0; i < 7; i++) remember(`/p${i}`, `goal ${i}`, s);
    remember("/p5", "goal 5", s);
    const r = loadRecent(s);
    assert.equal(r.folders.length, RECENT_MAX);
    assert.deepEqual(r.folders.slice(0, 2), ["/p5", "/p6"]);
    assert.equal(r.prompts.filter((p) => p === "goal 5").length, 1);
  });

  it("ignores blank entries, junk storage and a broken store", () => {
    assert.deepEqual(remember("  ", "  ", memory()), { folders: [], prompts: [] });
    assert.deepEqual(loadRecent(memory("not json")), { folders: [], prompts: [] });
    assert.deepEqual(loadRecent(memory('{"folders":[1,"a",""],"prompts":"x"}')), { folders: ["a"], prompts: [] });
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    assert.deepEqual(remember("a", "b", broken), { folders: ["a"], prompts: ["b"] });
    assert.deepEqual(loadRecent(null), { folders: [], prompts: [] });
  });
});

describe("recent starts without storage", () => {
  it("still accumulates from the lists already on screen", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    const first = remember("a", "x", broken);
    assert.deepEqual(remember("b", "y", broken, first), { folders: ["b", "a"], prompts: ["y", "x"] });
  });
});
