import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GRAPH_NODES, demoVault, graphLayout, obsidianLink, searchTitles } from "../src/vault.ts";

describe("vault helpers", () => {
  it("builds an obsidian link with a fixed scheme and encoded parts", () => {
    assert.equal(obsidianLink("My Vault", "Notes/Plan & Ideas.md"), "obsidian://open?vault=My%20Vault&file=Notes%2FPlan%20%26%20Ideas");
    const evil = obsidianLink('x"><script>', "a/<img src=x onerror=1>.md");
    assert.ok(evil.startsWith("obsidian://open?vault="));
    assert.ok(!/[<>" ]/.test(evil), "no markup characters survive");
  });

  it("finds titles ignoring case, finds nothing for an empty query, and caps the list", () => {
    const nodes = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}.md`, title: i % 2 ? `Alpha ${i}` : `Beta ${i}` }));
    assert.equal(searchTitles(nodes, "  ").length, 0);
    assert.equal(searchTitles(nodes, "ALPHA", 10).length, 10);
    assert.ok(searchTitles(nodes, "alpha").every((n) => n.title.startsWith("Alpha")));
    assert.equal(searchTitles(nodes, "zzz").length, 0);
  });

  it("lays the graph out deterministically, inside the shells, with the most linked closest", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, title: `n${i}` }));
    const links = Array.from({ length: 20 }, (_, i) => ({ from: `n${i + 1}`, to: "n0" }));
    const a = graphLayout(nodes, links);
    const b = graphLayout(nodes, links);
    assert.deepEqual(a, b);
    assert.equal(a.positions.length, 30 * 3);
    assert.equal(a.sizes.length, 30);
    assert.equal(a.lines.length, 20 * 6);
    for (let i = 0; i < 30; i++) {
      const r = Math.hypot(a.positions[i * 3] as number, a.positions[i * 3 + 1] as number, a.positions[i * 3 + 2] as number);
      assert.ok(r >= 1.69 && r <= 3.01, `node ${i} radius ${r}`);
    }
    const nearest = Math.min(...Array.from({ length: 30 }, (_, i) => Math.hypot(a.positions[i * 3] as number, a.positions[i * 3 + 1] as number, a.positions[i * 3 + 2] as number)));
    assert.ok(Math.hypot(a.positions[0] as number, a.positions[1] as number, a.positions[2] as number) - nearest < 1e-9, "the hub note is the closest");
    assert.ok((a.sizes[0] as number) > (a.sizes[29] as number));
  });

  it("copes with no notes, one note, links to unknown notes, and more notes than it draws", () => {
    assert.deepEqual(graphLayout([], []), { positions: [], sizes: [], lines: [] });
    const one = graphLayout([{ id: "a", title: "a" }], [{ from: "a", to: "ghost" }]);
    assert.equal(one.positions.length, 3);
    assert.ok(one.positions.every(Number.isFinite));
    assert.equal(one.lines.length, 0);
    const many = graphLayout(Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, title: "t" })), []);
    assert.equal(many.sizes.length, MAX_GRAPH_NODES);
  });

  it("makes a demo vault of 60 notes whose links all point at notes that exist", () => {
    const v = demoVault();
    assert.equal(v.noteCount, 60);
    const ids = new Set(v.nodes.map((n) => n.id));
    assert.ok(v.links.length > 0 && v.links.every((l) => ids.has(l.from) && ids.has(l.to)));
    assert.equal(v.recent.length, 5);
  });
});
