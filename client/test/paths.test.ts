import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUB_RADIUS, MAX_ROOMS, ROOM_D, ROOM_W, SEATS_PER_ROOM, SEAT_COUNT, roomCenter } from "../src/office/rooms.ts";
import { WALK_SPEED, obstacles, pointAlong, routeLength, routeSeconds, seatSpot, visitSpot, walkRoute, type Point, type Stand } from "../src/office/paths.ts";

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Does the segment touch the rectangle (slab method)? */
function hits(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [p, d, lo, hi] of [
    [a.x, b.x - a.x, r.minX, r.maxX],
    [a.z, b.z - a.z, r.minZ, r.maxZ],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return false;
    } else {
      const [u, v] = [(lo - p) / d, (hi - p) / d].sort((x, y) => x - y) as [number, number];
      t0 = Math.max(t0, u);
      t1 = Math.min(t1, v);
      if (t0 > t1) return false;
    }
  }
  return true;
}

const insideRoom = (slot: number, p: Point) => Math.abs(p.x - roomCenter(slot).x) <= ROOM_W / 2 + 1e-6 && Math.abs(p.z - roomCenter(slot).z) <= ROOM_D / 2 + 1e-6;
const stands = (seat: number): Stand[] => [
  { seat, at: "seat" },
  { seat, at: "visit" },
];

describe("walking routes", () => {
  it("starts and ends exactly at the standing places, with real numbers", () => {
    for (const from of [0, 4, 7, 13, 47]) {
      for (const to of [0, 5, 20, 31, 46]) {
        for (const a of stands(from)) {
          for (const b of stands(to)) {
            if (from === to && a.at === b.at) continue;
            const route = walkRoute(a, b);
            const start = a.at === "seat" ? seatSpot(from) : visitSpot(from);
            const end = b.at === "seat" ? seatSpot(to) : visitSpot(to);
            assert.ok(Math.hypot((route[0] as Point).x - start.x, (route[0] as Point).z - start.z) < 1e-6, `start ${from}>${to}`);
            assert.ok(Math.hypot((route.at(-1) as Point).x - end.x, (route.at(-1) as Point).z - end.z) < 1e-6, `end ${from}>${to}`);
            assert.ok(route.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)));
          }
        }
      }
    }
  });

  it("never walks through a desk or another person's chair, for every pair of seats", () => {
    for (let from = 0; from < SEAT_COUNT; from++) {
      for (let to = 0; to < SEAT_COUNT; to += 5) {
        for (const a of stands(from)) {
          for (const b of stands(to)) {
            if (from === to && a.at === b.at) continue;
            const route = walkRoute(a, b);
            for (let i = 1; i < route.length; i++) {
              const [p, q] = [route[i - 1] as Point, route[i] as Point];
              for (const stand of [a, b]) {
                const slot = Math.floor(stand.seat / SEATS_PER_ROOM);
                if (!insideRoom(slot, p) || !insideRoom(slot, q)) continue;
                const c = roomCenter(slot);
                const local = (pt: Point) => ({ x: pt.x - c.x, z: pt.z - c.z });
                // Your own chair is not an obstacle on the way out or in.
                const own = [a, b].filter((x) => x.at === "seat" && Math.floor(x.seat / SEATS_PER_ROOM) === slot).map((x) => x.seat % SEATS_PER_ROOM);
                const rects = obstacles().filter((_, k) => !(k % 2 === 1 && own.includes((k - 1) / 2)));
                for (const r of rects) assert.equal(hits(local(p), local(q), r), false, `${a.at}${from} to ${b.at}${to}: segment ${i} meets an obstacle`);
              }
            }
          }
        }
      }
    }
  });

  it("goes round the hub, never over it, between any two rooms", () => {
    for (let ra = 0; ra < MAX_ROOMS; ra++) {
      for (let rb = 0; rb < MAX_ROOMS; rb++) {
        if (ra === rb) continue;
        const route = walkRoute({ seat: ra * SEATS_PER_ROOM, at: "seat" }, { seat: rb * SEATS_PER_ROOM + 3, at: "visit" });
        for (let i = 1; i < route.length; i++) {
          const [p, q] = [route[i - 1] as Point, route[i] as Point];
          // Distance from the hub's centre to the segment.
          const dx = q.x - p.x;
          const dz = q.z - p.z;
          const len2 = dx * dx + dz * dz;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(p.x * dx + p.z * dz) / len2));
          assert.ok(Math.hypot(p.x + dx * t, p.z + dz * t) > HUB_RADIUS, `rooms ${ra}>${rb} segment ${i}`);
        }
      }
    }
  });

  it("is as long one way as the other, and a walk in one room is shorter than to another room", () => {
    const a = { seat: 2, at: "seat" } as const;
    const b = { seat: 9 + 6, at: "visit" } as const;
    assert.ok(Math.abs(routeLength(walkRoute(a, b)) - routeLength(walkRoute(b, a))) < 1e-6);
    const same = routeLength(walkRoute({ seat: 0, at: "seat" }, { seat: 5, at: "visit" }));
    const other = routeLength(walkRoute({ seat: 0, at: "seat" }, { seat: 6, at: "visit" }));
    assert.ok(same < other);
    assert.ok(same > 1);
  });

  it("finds the position and facing along a route, clamped at both ends", () => {
    const route = [
      { x: 0, z: 0 },
      { x: 0, z: 4 },
      { x: 3, z: 4 },
    ];
    assert.deepEqual(pointAlong(route, 0), { x: 0, z: 0, heading: 0 });
    const mid = pointAlong(route, 2);
    assert.equal(mid.z, 2);
    assert.equal(mid.heading, 0);
    const turn = pointAlong(route, 5);
    assert.equal(turn.x, 1);
    assert.ok(Math.abs(turn.heading - Math.PI / 2) < 1e-9);
    assert.deepEqual({ x: pointAlong(route, 99).x, z: pointAlong(route, 99).z }, { x: 3, z: 4 });
    assert.equal(pointAlong(route, -5).z, 0);
    assert.equal(routeSeconds(route), 7 / WALK_SPEED);
  });
});
