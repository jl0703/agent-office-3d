import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildingFor, ENTRANCE, MAX_DEPARTMENTS, SEAT_COUNT, seatPoint, VISITORS_KEY, type Building } from "../src/office/building.ts";
import { DOOR_GAP, furnitureOf, hubCentre, HUB_SCALE, wallsOf, WALL_THICK, type Wall } from "../src/office/buildingParts.ts";
import { obstacles, pointAlong, routeLength, routeSeconds, seatSpot, visitSpot, walkRoute, WALK_SPEED, CORRIDOR_Z, type Point, type Rect } from "../src/office/walk.ts";
import type { Person } from "../src/team.ts";

const people: Person[] = ["Engineering", "Quality", "Design", "Product", "Operations", "Sales"].map((d, i) => ({ id: i.toString(16).padStart(12, "0"), name: `P${i}`, role: "r", brief: "", reportsTo: "000000000fff", department: d }));
const building: Building = buildingFor(people);
const allSeats = Array.from({ length: SEAT_COUNT }, (_, i) => i);
const rectOfWall = (w: Wall): Rect => ({ minX: w.x - w.w / 2, maxX: w.x + w.w / 2, minZ: w.z - w.d / 2, maxZ: w.z + w.d / 2 });
const within = (r: Rect, p: Point, shrink = 0) => p.x > r.minX + shrink && p.x < r.maxX - shrink && p.z > r.minZ + shrink && p.z < r.maxZ - shrink;
const samples = (route: Point[], step = 0.15): Point[] => {
  const out: Point[] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1] as Point;
    const b = route[i] as Point;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
};

describe("the building: walls and furniture", () => {
  const walls = wallsOf(building);

  it("keeps every wall inside the building and leaves a gap at every door and at the entrance", () => {
    for (const w of walls) {
      assert.ok(w.x - w.w / 2 >= building.rooms[0]!.rect.minX - 20 && w.w > 0 && w.d > 0);
    }
    const boxes = walls.map(rectOfWall);
    for (const room of building.rooms) {
      if (room.kind === "visitors") continue;
      assert.equal(boxes.some((b) => within(b, room.door, 0.02)), false, `${room.key}: nothing stands in the door`);
      const beside = { x: room.door.x + DOOR_GAP / 2 + 0.3, z: room.door.z };
      assert.equal(boxes.some((b) => within(b, beside, 0.02)), true, `${room.key}: the wall continues beside the door`);
    }
    assert.equal(boxes.some((b) => within(b, ENTRANCE, 0.02)), false, "the entrance is open");
  });

  it("makes the walls the camera looks past low glass, and the back and left walls full height", () => {
    const north = walls.filter((w) => Math.abs(w.z - building.rooms[0]!.rect.minZ) < 1e-6);
    assert.ok(north.length > 0 && north.every((w) => w.kind === "tall"), "the back wall is tall");
    const corridorFacing = walls.filter((w) => w.d === WALL_THICK && Math.abs(w.z - -4.2) < 1e-6);
    assert.ok(corridorFacing.length > 0 && corridorFacing.every((w) => w.kind === "glass"), "the walls on the corridor are low glass");
    assert.ok(walls.some((w) => w.kind === "tall" && w.w === WALL_THICK), "the left walls are tall");
  });

  it("puts furniture inside its room, clear of every desk and chair and of the door", () => {
    for (const room of building.rooms) {
      const seats = room.desks.map((_, i) => allSeats.find((s) => seatPoint(building, s)?.x === room.desks[i]!.x && seatPoint(building, s)?.z === room.desks[i]!.z)!);
      const solid = obstacles(building, seats);
      const northDoor = room.door.z === room.rect.minZ;
      const doorZone: Rect = { minX: room.door.x - 1.2, maxX: room.door.x + 1.2, minZ: northDoor ? room.door.z : room.door.z - 1.6, maxZ: northDoor ? room.door.z + 1.6 : room.door.z };
      for (const f of furnitureOf(room)) {
        const box: Rect = { minX: f.x - f.w / 2, maxX: f.x + f.w / 2, minZ: f.z - f.d / 2, maxZ: f.z + f.d / 2 };
        assert.ok(box.minX >= room.rect.minX - 0.01 && box.maxX <= room.rect.maxX + 0.01 && box.minZ >= room.rect.minZ - 0.01 && box.maxZ <= room.rect.maxZ + 0.01, `${room.key}: furniture inside the room`);
        for (const s of solid) assert.equal(box.minX < s.maxX && s.minX < box.maxX && box.minZ < s.maxZ && s.minZ < box.maxZ, false, `${room.key}: furniture clear of the desks`);
        if (room.kind !== "visitors") assert.equal(box.minX < doorZone.maxX && doorZone.minX < box.maxX && box.minZ < doorZone.maxZ && doorZone.minZ < box.maxZ, false, `${room.key}: furniture clear of the door`);
      }
    }
  });

  it("stands the hub in the middle of the Library, small enough to fit", () => {
    const lib = building.rooms.find((r) => r.kind === "library")!;
    const c = hubCentre(building);
    assert.deepEqual(c, { x: (lib.rect.minX + lib.rect.maxX) / 2, z: (lib.rect.minZ + lib.rect.maxZ) / 2 });
    const radius = 3.5 * HUB_SCALE;
    assert.ok(c.x - radius > lib.rect.minX && c.x + radius < lib.rect.maxX && c.z - radius > lib.rect.minZ && c.z + radius < lib.rect.maxZ);
  });
});

describe("the building: walking", () => {
  const walls = wallsOf(building).map(rectOfWall);
  const solidFor = (except: number) => obstacles(building, allSeats, except);

  /** A fixed spread of pairs, so the test is quick and the same every time. */
  const pairs: [number, number][] = [];
  for (let i = 0; i < SEAT_COUNT; i += 2) for (let j = 1; j < SEAT_COUNT; j += 5) if (i !== j) pairs.push([i, j]);

  it("starts and ends at the right places, and goes through no wall, no desk and no chair, in or out of the building", () => {
    const b = building.rooms;
    const bounds = { minX: Math.min(...b.map((r) => r.rect.minX)), maxX: Math.max(...b.map((r) => r.rect.maxX)), minZ: Math.min(...b.map((r) => r.rect.minZ)), maxZ: Math.max(...b.map((r) => r.rect.maxZ)) };
    assert.ok(pairs.length > 300);
    for (const [from, to] of pairs) {
      const route = walkRoute(building, { seat: from, at: "seat" }, { seat: to, at: "visit" });
      assert.deepEqual(route[0], seatSpot(building, from));
      assert.deepEqual(route.at(-1), visitSpot(building, to));
      const solid = solidFor(from);
      for (const p of samples(route)) {
        assert.ok(p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ, `${from}->${to}: inside the building`);
        assert.equal(walls.some((w) => within(w, p, 0.02)), false, `${from}->${to}: no wall at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
        assert.equal(solid.some((s) => within(s, p, 0.02)), false, `${from}->${to}: no desk or chair at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
      }
    }
  });

  it("walks home the same way it came, along the corridor between rooms and through the spine to Visitors", () => {
    const fe = allSeats.find((s) => seatPoint(building, s)?.z === building.rooms.find((r) => r.slot === 0)!.desks[0]!.z && seatPoint(building, s)?.x === building.rooms.find((r) => r.slot === 0)!.desks[0]!.x)!;
    const lobby = building.rooms.find((r) => r.key === VISITORS_KEY)!;
    const lobbySeat = allSeats.find((s) => seatPoint(building, s)?.x === lobby.desks[0]!.x && seatPoint(building, s)?.z === lobby.desks[0]!.z)!;
    const route = walkRoute(building, { seat: fe, at: "seat" }, { seat: lobbySeat, at: "visit" });
    assert.ok(route.some((p) => p.z === CORRIDOR_Z), "it uses the corridor");
    assert.ok(route.some((p) => p.x === 0 && p.z > 0), "it goes down the spine");
    const back = walkRoute(building, { seat: lobbySeat, at: "visit" }, { seat: fe, at: "seat" });
    assert.equal(Math.round(routeLength(back) * 100), Math.round(routeLength(route) * 100), "the way back is as long");
    const same = walkRoute(building, { seat: fe, at: "seat" }, { seat: fe + 1, at: "visit" });
    assert.ok(same.every((p) => p.z > -4.2 || p.z < -4.2) && routeLength(same) < 12, "a visit within a room stays in the room");
    assert.ok(samples(same).every((p) => !walls.some((w) => within(w, p, 0.02))));
  });

  it("gives no route for a desk that is not there, and turns a route into time and positions", () => {
    assert.deepEqual(walkRoute(building, { seat: 0, at: "seat" }, { seat: 9999, at: "visit" }), []);
    const route = walkRoute(building, { seat: 0, at: "seat" }, { seat: SEAT_COUNT - 1, at: "visit" });
    assert.ok(Math.abs(routeSeconds(route) - routeLength(route) / WALK_SPEED) < 1e-9);
    assert.deepEqual(pointAlong(route, 0), { x: route[0]!.x, z: route[0]!.z, heading: pointAlong(route, 0).heading });
    const end = pointAlong(route, 1e6);
    assert.ok(Math.hypot(end.x - route.at(-1)!.x, end.z - route.at(-1)!.z) < 1e-9);
    assert.ok(MAX_DEPARTMENTS === 6);
  });
});
