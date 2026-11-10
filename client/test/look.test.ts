import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILDING_RECT, ENTRANCE, buildingFor } from "../src/office/building.ts";
import { BENCH_LIMIT, BUSH_LIMIT, TREE_LIMIT, floorTone, groundsOf, isTall, viewSideOf, wallsOf } from "../src/office/buildingParts.ts";

const team = [{ id: "a", name: "A", role: "CEO", brief: "", reportsTo: null, department: "Management" }, { id: "b", name: "B", role: "Dev", brief: "", reportsTo: "a", department: "Engineering" }, { id: "c", name: "C", role: "QA", brief: "", reportsTo: "a", department: "Quality" }];
const building = buildingFor(team);
const walls = wallsOf(building);
const B = BUILDING_RECT;

describe("walls follow the view", () => {
  it("looks as before from the opening side (south and east)", () => {
    for (const w of walls) assert.equal(isTall(w, { x: 1, z: 1 }), w.kind === "tall", `${w.x},${w.z}`);
  });

  it("drops the walls that would stand between the camera and a room, and raises the ones behind it", () => {
    const north = walls.filter((w) => w.z === B.minZ && w.d === 0.25 && w.w > 10);
    const south = walls.filter((w) => w.z === B.maxZ && w.d === 0.25 && w.w > 10);
    const west = walls.filter((w) => w.x === B.minX && w.w === 0.25 && w.d > 10);
    const east = walls.filter((w) => w.x === B.maxX && w.w === 0.25 && w.d > 10);
    for (const group of [north, south, west, east]) assert.ok(group.length > 0);
    // Seen from the north: the north wall is in front, the south wall behind.
    assert.ok(north.every((w) => !isTall(w, { x: 1, z: -1 })));
    assert.ok(south.every((w) => isTall(w, { x: 1, z: -1 })));
    // Seen from the west: the west wall is in front, the east wall behind.
    assert.ok(west.every((w) => !isTall(w, { x: -1, z: 1 })));
    assert.ok(east.every((w) => isTall(w, { x: -1, z: 1 })));
    // From the south-east the near walls are glass, the far ones tall (the opening view).
    assert.ok(north.every((w) => isTall(w, { x: 1, z: 1 })) && south.every((w) => !isTall(w, { x: 1, z: 1 })));
  });

  it("keeps a room's back wall on the outer edge in step with the outer wall", () => {
    const backs = walls.filter((w) => w.z === B.minZ && w.w < 12 && w.d === 0.25);
    assert.ok(backs.length > 0);
    for (const w of backs) {
      assert.equal(isTall(w, { x: 1, z: 1 }), true);
      assert.equal(isTall(w, { x: 1, z: -1 }), false, "no tall wall between the camera and the rooms along the north edge");
    }
  });

  it("keeps the walls on the corridor and between the rows as they are from every side", () => {
    const fixed = walls.filter((w) => !w.flips);
    assert.ok(fixed.length > 0);
    for (const w of fixed) for (const x of [1, -1] as const) for (const z of [1, -1] as const) assert.equal(isTall(w, { x, z }), w.kind === "tall");
  });

  it("builds a wall between side-by-side rooms once, as low glass whatever the side, so neither room is hidden", () => {
    const keys = walls.map((w) => `${w.x.toFixed(3)},${w.z.toFixed(3)},${w.w.toFixed(3)},${w.d.toFixed(3)}`);
    // A wall between two side-by-side rooms is the same place from both sides, so one piece only.
    const shared = walls.filter((w) => !w.flips && w.kind === "glass" && w.w === 0.25 && w.d > 5 && w.x > B.minX && w.x < B.maxX && w.x !== 0);
    assert.ok(shared.length > 0, "side-by-side rooms share walls");
    for (const w of shared) for (const x of [1, -1] as const) assert.equal(isTall(w, { x, z: 1 }), false);
    assert.equal(new Set(keys).size, keys.length, "no two walls in the same place");
  });

  it("reads which side the camera is on from where it stands", () => {
    assert.deepEqual(viewSideOf({ x: 10, z: 10 }, { x: 0, z: 0 }), { x: 1, z: 1 });
    assert.deepEqual(viewSideOf({ x: -10, z: 10 }, { x: 0, z: 0 }), { x: -1, z: 1 });
    assert.deepEqual(viewSideOf({ x: 10, z: -10 }, { x: 0, z: 0 }), { x: 1, z: -1 });
    assert.deepEqual(viewSideOf({ x: -1, z: -1 }, { x: 0, z: 0 }), { x: -1, z: -1 });
    assert.deepEqual(viewSideOf({ x: 0, z: 0 }, { x: 0, z: 0 }), { x: -1, z: -1 }, "straight above is treated as one side, not an error");
  });
});

describe("the grounds", () => {
  const g = groundsOf();
  const clear = (x: number, z: number, margin: number) => x < B.minX - margin || x > B.maxX + margin || z < B.minZ - margin || z > B.maxZ + margin;

  it("puts every tree and bush outside the walls and on the lawn", () => {
    assert.ok(g.trees.length > 20 && g.trees.length <= TREE_LIMIT, `trees: ${g.trees.length}`);
    assert.ok(g.bushes.length > 10 && g.bushes.length <= BUSH_LIMIT, `bushes: ${g.bushes.length}`);
    for (const t of g.trees) {
      assert.ok(clear(t.x, t.z, 1.5), `tree ${t.x},${t.z} is clear of the building`);
      assert.ok(t.x > g.lawn.minX && t.x < g.lawn.maxX && t.z > g.lawn.minZ && t.z < g.lawn.maxZ, "on the lawn");
      assert.ok(t.scale >= 0.8 && t.scale <= 1.4);
    }
    for (const b of g.bushes) assert.ok(clear(b.x, b.z, 0.5), `bush ${b.x},${b.z} is clear of the walls`);
  });

  it("keeps the path to the entrance free of trees, bushes and benches", () => {
    assert.equal(g.path.minZ, B.maxZ);
    assert.ok(g.path.minX < ENTRANCE.x && g.path.maxX > ENTRANCE.x, "the path runs from the entrance");
    const onPath = (x: number, z: number) => x > g.path.minX && x < g.path.maxX && z > B.maxZ - 0.5;
    for (const t of g.trees) assert.equal(onPath(t.x, t.z), false);
    for (const b of g.bushes) assert.equal(onPath(b.x, b.z), false);
    assert.ok(g.benches.length > 0 && g.benches.length <= BENCH_LIMIT);
    for (const b of g.benches) assert.equal(onPath(b.x, b.z), false);
  });

  it("is the same every time", () => {
    assert.deepEqual(groundsOf(), g);
  });
});

describe("room floors", () => {
  it("gives wood to the executives and the library, a neutral to the open plan, and the room's own colour to the rest", () => {
    assert.notEqual(floorTone("management", "light"), null);
    assert.equal(floorTone("library", "light"), floorTone("management", "light"));
    assert.notEqual(floorTone("visitors", "light"), floorTone("management", "light"));
    for (const kind of ["engineering", "qa", "design", "product", "operations", "general"] as const) assert.equal(floorTone(kind, "light"), null, kind);
  });

  it("has a different tone in the dark scheme", () => {
    for (const kind of ["management", "library", "visitors"] as const) assert.notEqual(floorTone(kind, "dark"), floorTone(kind, "light"), kind);
  });
});
