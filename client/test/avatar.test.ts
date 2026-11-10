import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AVATAR_KEYS, AVATAR_PARTS, isAvatar } from "../../shared/avatar.ts";
import { BACKGROUND, defaultAvatar, HAIR_COLOR, LABELS, OUTFIT_COLOR, randomAvatar, sameAvatar, SKIN } from "../src/avatar.ts";
import { avatarOf, demoTeam, toPerson } from "../src/team.ts";

describe("avatars: making a look", () => {
  it("gives every part a number inside its list, from any random source", () => {
    for (const rng of [() => 0, () => 0.999999, () => 0.5, Math.random]) {
      const look = randomAvatar(rng);
      assert.ok(isAvatar(look), JSON.stringify(look));
    }
    assert.deepEqual(randomAvatar(() => 0), { skin: 0, hair: 0, hairColor: 0, eyes: 0, mouth: 0, glasses: 0, outfit: 0, outfitColor: 0, background: 0 });
    const top = randomAvatar(() => 0.999999);
    assert.ok(AVATAR_KEYS.every((k) => top[k] === AVATAR_PARTS[k] - 1), "the last choice of every part can be reached");
  });

  it("makes the same default for the same id and different ones for different ids", () => {
    assert.deepEqual(defaultAvatar("0000000000a1"), defaultAvatar("0000000000a1"));
    const looks = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(defaultAvatar(`id-${i}`))));
    assert.ok(looks.size > 25, `ids look different (${looks.size} of 30)`);
    assert.equal(sameAvatar(defaultAvatar("a"), defaultAvatar("a")), true);
    assert.equal(sameAvatar(defaultAvatar("a"), defaultAvatar("b")), false);
  });

  it("has a word or a colour for every choice, so the designer has a button for each", () => {
    const sizes = { skin: SKIN.length, hairColor: HAIR_COLOR.length, outfitColor: OUTFIT_COLOR.length, background: BACKGROUND.length };
    for (const [k, n] of Object.entries(sizes)) assert.equal(n, AVATAR_PARTS[k as keyof typeof sizes], k);
    for (const k of AVATAR_KEYS) assert.equal(LABELS[k].length, AVATAR_PARTS[k], k);
  });
});

describe("avatars: a person's picture", () => {
  it("uses the person's own look, or the default made from their id", () => {
    const look = randomAvatar(() => 0.3);
    assert.deepEqual(avatarOf({ id: "x", avatar: look }), look);
    assert.deepEqual(avatarOf({ id: "x" }), defaultAvatar("x"));
    assert.ok(demoTeam().every((p) => isAvatar(avatarOf(p))));
  });

  it("reads a look from the server and drops one that is out of range", () => {
    const base = { id: "a", name: "A", role: "r", brief: "", reportsTo: null };
    const look = randomAvatar(() => 0.3);
    assert.deepEqual(toPerson({ ...base, avatar: look })?.avatar, look);
    assert.equal(toPerson({ ...base, avatar: { ...look, skin: 99 } })?.avatar, undefined);
    assert.equal(toPerson(base)?.avatar, undefined);
  });
});
