import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildingFor, ENTRANCE, MAX_DEPARTMENTS, SEAT_COUNT, seatPoint, VISITORS_KEY, type Building } from "../src/office/building.ts";
import { DOOR_GAP, furnitureOf, standingSpots, wallsOf, WALL_THICK, type Wall } from "../src/office/buildingParts.ts";
import { obstacles, placeRoute, pointAlong, routeLength, routeSeconds, seatSpot, visitSpot, walkRoute, WALK_SPEED, CORRIDOR_Z, type Point, type Rect } from "../src/office/walk.ts";
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
        // Every room also gets a plant in its near-left corner and a lamp in its near-right one (Office.tsx), about 0.35 m across.
        for (const spot of [{ x: room.rect.minX + 0.45, z: room.rect.maxZ - 0.5 }, { x: room.rect.maxX - 0.45, z: room.rect.maxZ - 0.5 }]) assert.equal(box.minX < spot.x + 0.35 && spot.x - 0.35 < box.maxX && box.minZ < spot.z + 0.35 && spot.z - 0.35 < box.maxZ, false, `${room.key}: furniture clear of the plant and the lamp`);
        if (room.kind !== "visitors") assert.equal(box.minX < doorZone.maxX && doorZone.minX < box.maxX && box.minZ < doorZone.maxZ && doorZone.minZ < box.maxZ, false, `${room.key}: furniture clear of the door`);
      }
    }
  });

  it("furnishes the shared rooms: a long table and chairs, a counter with a fridge and stools, a sofa facing a TV", () => {
    const furniture = (kind: string) => furnitureOf(building.rooms.find((r) => r.kind === kind)!);
    const meeting = furniture("meeting");
    assert.ok(meeting.some((f) => f.w >= 4 && f.h < 1), "a long table");
    assert.ok(meeting.filter((f) => f.h >= 0.8 && f.w < 0.7 && f.d < 0.7).length >= 6, "six chairs");
    const pantry = furniture("pantry");
    assert.ok(pantry.some((f) => f.w >= 4), "a counter");
    assert.ok(pantry.some((f) => f.h >= 1.8), "a fridge");
    assert.ok(pantry.filter((f) => f.h > 0.6 && f.h < 0.8 && f.w < 0.6).length >= 4, "four stools");
    const lounge = furniture("lounge");
    assert.ok(lounge.some((f) => f.d >= 3 && f.h >= 0.9), "a sofa with a back");
    assert.ok(lounge.some((f) => f.w <= 0.2 && f.d >= 2), "a TV");
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

describe("the shared rooms: places to stand and the way there", () => {
  const shared = building.rooms.filter((r) => r.desks.length === 0);
  const wallBoxes = wallsOf(building).map(rectOfWall);
  const solidFor = (except: number) => obstacles(building, allSeats, except);
  const boxOf = (f: ReturnType<typeof furnitureOf>[number], grow = 0): Rect => ({ minX: f.x - f.w / 2 - grow, maxX: f.x + f.w / 2 + grow, minZ: f.z - f.d / 2 - grow, maxZ: f.z + f.d / 2 + grow });

  it("has four places in each shared room and none in a room with desks", () => {
    assert.deepEqual(shared.map((r) => r.kind).sort(), ["lounge", "meeting", "pantry"]);
    for (const room of shared) assert.equal(standingSpots(room).length, 4, room.key);
    for (const room of building.rooms.filter((r) => r.desks.length > 0)) assert.equal(standingSpots(room).length, 0, room.key);
  });

  it("keeps every place inside its room, clear of the furniture, the corner plant and lamp, and of each other", () => {
    for (const room of shared) {
      const spots = standingSpots(room);
      const r = room.rect;
      for (const [i, p] of spots.entries()) {
        assert.ok(p.x > r.minX + 0.5 && p.x < r.maxX - 0.5 && p.z > r.minZ + 0.5 && p.z < r.maxZ - 0.5, `${room.key} #${i}: inside the room`);
        for (const f of furnitureOf(room)) assert.equal(within(boxOf(f, 0.3), p), false, `${room.key} #${i}: clear of the furniture`);
        for (const corner of [{ x: r.minX + 0.45, z: r.maxZ - 0.5 }, { x: r.maxX - 0.45, z: r.maxZ - 0.5 }]) assert.ok(Math.hypot(p.x - corner.x, p.z - corner.z) > 0.7, `${room.key} #${i}: clear of the plant and the lamp`);
        for (const q of spots.slice(i + 1)) assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= 0.8, `${room.key}: two places are not on top of each other`);
      }
    }
  });

  it("walks from every desk to every place by the door and the corridor, through no wall, desk, chair or furniture", () => {
    let routes = 0;
    for (const seat of allSeats) {
      const solid = solidFor(seat);
      for (const room of shared) {
        const furniture = furnitureOf(room).map((f) => boxOf(f, 0.1));
        for (let spot = 0; spot < 4; spot++) {
          const route = placeRoute(building, { seat, at: "seat" }, { room: room.key, spot });
          routes++;
          const label = `${seat} -> ${room.key} #${spot}`;
          assert.deepEqual(route[0], seatSpot(building, seat), `${label}: starts at the desk`);
          assert.deepEqual(route.at(-1), { x: standingSpots(room)[spot]!.x, z: standingSpots(room)[spot]!.z }, `${label}: ends at the place`);
          assert.ok(route.some((p) => p.x === room.door.x && p.z === room.door.z), `${label}: goes in at the door`);
          assert.ok(routeLength(route) < 80, `${label}: a sensible length`);
          for (const p of samples(route)) {
            assert.equal(wallBoxes.some((w) => within(w, p, 0.02)), false, `${label}: no wall at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
            assert.equal(solid.some((x) => within(x, p, 0.02)), false, `${label}: no desk or chair at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
            assert.equal(furniture.some((f) => within(f, p)), false, `${label}: no furniture at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
          }
        }
      }
    }
    assert.ok(routes > 600, `routes tried: ${routes}`);
  });

  it("starts from a desk in Visitors by the spine, and gives no route to a place or a seat that is not there", () => {
    const lobby = building.rooms.find((r) => r.key === VISITORS_KEY)!;
    const lobbySeat = allSeats.find((s) => seatPoint(building, s)?.x === lobby.desks[0]!.x && seatPoint(building, s)?.z === lobby.desks[0]!.z)!;
    const route = placeRoute(building, { seat: lobbySeat, at: "seat" }, { room: "pantry", spot: 0 });
    assert.ok(route.some((p) => p.x === 0 && p.z > 0), "down the spine");
    assert.ok(route.some((p) => p.z === CORRIDOR_Z), "along the corridor");
    assert.deepEqual(placeRoute(building, { seat: 0, at: "seat" }, { room: "pantry", spot: 4 }), []);
    assert.deepEqual(placeRoute(building, { seat: 0, at: "seat" }, { room: "engineering", spot: 0 }), []);
    assert.deepEqual(placeRoute(building, { seat: 0, at: "seat" }, { room: "nowhere", spot: 0 }), []);
    assert.deepEqual(placeRoute(building, { seat: 9999, at: "seat" }, { room: "pantry", spot: 0 }), []);
  });
});
