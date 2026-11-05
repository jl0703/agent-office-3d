import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitCamera, truncateTag } from "../src/office/layout.ts";
import { ACCESSORIES, CHARACTER_COLORS, FAMILY_COLORS, FAMILY_LETTERS, STATUS_COLOR, STATUSES, characterStyle, hashId } from "../src/office/palette.ts";
import { REST_POSE, blendPose, poseFor, type Pose } from "../src/office/poses.ts";
import { createSelection } from "../src/office/selection.ts";

describe("office layout", () => {
  it("frames a bigger area from further away, and a narrow window from further away too", () => {
    const small = { minX: -5, maxX: 5, minZ: -5, maxZ: 5 };
    const big = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
    assert.ok(fitCamera(big, 1.6).distance > fitCamera(small, 1.6).distance);
    assert.ok(fitCamera(big, 0.5).distance > fitCamera(big, 1.8).distance);
    const t = fitCamera({ minX: 0, maxX: 10, minZ: 4, maxZ: 8 }, 1.5).target;
    assert.equal(t[0], 5);
    assert.equal(t[2], 6);
    for (const bad of [0, -3, NaN]) assert.ok(Number.isFinite(fitCamera(small, bad).distance), `aspect ${bad}`);
    assert.ok(fitCamera(small, 0.5).target[1] > fitCamera(small, 1.6).target[1], "a tall, narrow window aims higher");
  });

  it("shortens a tag to 18 characters plus an ellipsis without splitting a character", () => {
    assert.equal(truncateTag("Short"), "Short");
    assert.equal(truncateTag("a".repeat(25)), "a".repeat(18) + "…");
    assert.equal(truncateTag("a".repeat(18)), "a".repeat(18));
    assert.equal(truncateTag("x".repeat(17) + "😀😀😀"), "x".repeat(17) + "😀…");
    assert.equal(truncateTag("  two\n\tlines  "), "two lines");
    assert.equal(truncateTag(""), "");
    assert.equal(truncateTag("abcdef", 3), "abc…");
  });
});

describe("office palette", () => {
  it("gives the same look to the same id, and spreads ids across the palette", () => {
    assert.deepEqual(characterStyle("session-1"), characterStyle("session-1"));
    const colors = new Set<number>();
    const accessories = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const s = characterStyle(`agent-${i}`);
      assert.ok(s.color >= 0 && s.color < CHARACTER_COLORS.length);
      colors.add(s.color);
      accessories.add(s.accessory);
    }
    assert.equal(colors.size, CHARACTER_COLORS.length);
    assert.equal(accessories.size, ACCESSORIES.length);
    assert.equal(hashId(""), 0x811c9dc5);
    assert.notEqual(hashId("a"), hashId("b"));
  });

  it("has a colour for every status in both schemes, each distinct, and six family colours with letters", () => {
    for (const scheme of ["light", "dark"] as const) {
      assert.equal(new Set(STATUSES.map((s) => STATUS_COLOR[scheme][s])).size, STATUSES.length, scheme);
    }
    assert.equal(FAMILY_COLORS.length, 6);
    assert.deepEqual([...FAMILY_LETTERS], ["A", "B", "C", "D", "E", "F"]);
  });
});

describe("poses", () => {
  const poses = (t: number, since = 10, reduced = false) => Object.fromEntries(STATUSES.map((s) => [s, poseFor(s, t, since, reduced)]));
  const same = (a: Pose, b: Pose) => (Object.keys(a) as (keyof Pose)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-9);

  it("gives every status a pose of its own, with real numbers", () => {
    const p = poses(1.234, 10);
    for (const s of STATUSES) for (const v of Object.values(p[s] as Pose)) assert.ok(Number.isFinite(v), s);
    for (let i = 0; i < STATUSES.length; i++) {
      for (let j = i + 1; j < STATUSES.length; j++) {
        const a = STATUSES[i] as string;
        const b = STATUSES[j] as string;
        if (a === "idle" && b === "detached") continue; // detached shares the idle posture; it differs by its ghost look
        assert.equal(same(p[a] as Pose, p[b] as Pose), false, `${a} differs from ${b}`);
      }
    }
  });

  it("types at 0.3 s intervals while working", () => {
    const at = (t: number) => poseFor("working", t, 10, false).armL;
    assert.ok(Math.abs(at(0.075) - at(0.375)) < 1e-9, "same after one period");
    assert.ok(Math.abs(at(0.075) - at(0.225)) > 0.1, "different half a period later");
  });

  it("stretches once when done, then stays still", () => {
    const early = poseFor("done", 5, 0.1, false).armL;
    const late = poseFor("done", 5, 3, false).armL;
    const later = poseFor("done", 9, 7, false).armL;
    assert.ok(early < late, "arms are higher during the stretch");
    assert.equal(late, later);
  });

  it("shakes its head when it errors, for 1.5 seconds only", () => {
    assert.ok(Math.abs(poseFor("error", 0, 0.125, false).headYaw) > 0.05);
    assert.equal(poseFor("error", 0, 2, false).headYaw, 0);
  });

  it("does not move on its own with reduced motion", () => {
    for (const s of STATUSES) {
      assert.ok(same(poseFor(s, 0.0, 0.0, true), poseFor(s, 3.7, 0.2, true)), s);
    }
    assert.equal(poseFor("working", 0.075, 0, true).armL, poseFor("working", 0.225, 0, true).armL);
    assert.equal(poseFor("error", 0, 0, true).headYaw, 0);
    assert.equal(poseFor("done", 0, 0, true).armL, poseFor("done", 0, 9, false).armL, "the stretch is already finished");
  });

  it("blends toward a target without overshoot, in about 400 ms, at any frame rate", () => {
    const target = poseFor("working", 0, 10, true);
    let a = REST_POSE;
    for (let i = 0; i < 25; i++) a = blendPose(a, target, 0.016); // 400 ms at 60 fps
    let b = REST_POSE;
    for (let i = 0; i < 12; i++) b = blendPose(b, target, 0.0333); // about 400 ms at 30 fps
    assert.ok(Math.abs(a.lean - target.lean) < 0.05 * Math.abs(target.lean), "close after 400 ms");
    assert.ok(Math.abs(a.lean - b.lean) < 0.01, "frame rate barely matters");
    assert.ok(a.lean <= target.lean && a.lean >= REST_POSE.lean, "no overshoot");
    assert.ok(same(blendPose(target, target, 0.016), target), "already there stays there");
  });
});

describe("selection", () => {
  it("keeps one selected and one hovered agent, and tells subscribers only about real changes", () => {
    const store = createSelection();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    assert.deepEqual(store.get(), { selected: null, hovered: null, room: null });
    store.select("a");
    store.select("a");
    assert.equal(calls, 1);
    store.hover("b");
    assert.deepEqual(store.get(), { selected: "a", hovered: "b", room: null });
    store.select(null);
    assert.deepEqual(store.get(), { selected: null, hovered: "b", room: null });
    const before = store.get();
    store.hover("b");
    assert.equal(store.get(), before, "the same state object when nothing changed");
    store.focusRoom("web");
    assert.equal(store.get().room, "web");
    assert.equal(calls, 4);
    store.focusRoom("web");
    assert.equal(calls, 4, "no call when the room is unchanged");
    off();
    store.select("c");
    assert.equal(calls, 4, "no calls after unsubscribing");
  });
});
