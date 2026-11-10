import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AVATAR_PARTS, type Avatar } from "../../shared/avatar.ts";
import { HAIR_COLOR, OUTFIT_COLOR, SKIN, defaultAvatar, randomAvatar } from "../src/avatar.ts";
import { hairGeometry, outfitGeometry, OUTFIT_TINTED } from "../src/office/geometry.ts";
import { lookOfAgent, lookOfAvatar } from "../src/office/look.ts";
import { CHARACTER_COLORS, characterStyle } from "../src/office/palette.ts";
import type { Person } from "../src/team.ts";

const base: Avatar = { skin: 0, hair: 0, hairColor: 0, eyes: 0, mouth: 0, glasses: 0, outfit: 0, outfitColor: 0, background: 0 };
const person = (id: string, avatar?: Avatar): Person => ({ id, name: "P", role: "Dev", brief: "", reportsTo: null, department: "", ...(avatar ? { avatar } : {}) });

describe("a look from an avatar", () => {
  it("takes the skin, hair, outfit and glasses from the avatar's numbers", () => {
    const look = lookOfAvatar({ ...base, skin: 3, hair: 2, hairColor: 5, outfit: 4, outfitColor: 6, glasses: 3 });
    assert.deepEqual(look, { skin: SKIN[3], hair: 2, hairColor: HAIR_COLOR[5], outfit: 4, outfitColor: OUTFIT_COLOR[6], accessory: "sunglasses" });
  });

  it("maps every glasses choice: none, round and square glasses, sunglasses", () => {
    assert.deepEqual([0, 1, 2, 3].map((glasses) => lookOfAvatar({ ...base, glasses }).accessory), ["none", "glasses", "glasses", "sunglasses"]);
  });

  it("gives a valid look for every value of every part, and a different one when a part differs", () => {
    for (const part of ["skin", "hair", "hairColor", "outfit", "outfitColor", "glasses"] as const) {
      const looks = Array.from({ length: AVATAR_PARTS[part] }, (_, i) => lookOfAvatar({ ...base, [part]: i }));
      for (const look of looks) assert.match(look.skin + look.hairColor + look.outfitColor, /^(#[0-9a-f]{6}){3}$/i);
      if (part !== "glasses") assert.equal(new Set(looks.map((l) => JSON.stringify(l))).size, AVATAR_PARTS[part], part);
    }
  });

  it("is the same for the same avatar", () => {
    for (let i = 0; i < 20; i++) {
      const a = randomAvatar(() => (i * 0.137) % 1);
      assert.deepEqual(lookOfAvatar(a), lookOfAvatar({ ...a }));
    }
  });
});

describe("a look for an agent", () => {
  it("uses the avatar of the person it works as", () => {
    const own: Avatar = { ...base, skin: 4, hair: 6, outfitColor: 2, glasses: 1 };
    const people = [person("p1", own), person("p2")];
    assert.deepEqual(lookOfAgent({ id: "a", personId: "p1" }, people), lookOfAvatar(own));
  });

  it("uses the person's default look, the one the Team page shows, when no picture was drawn", () => {
    assert.deepEqual(lookOfAgent({ id: "a", personId: "p2" }, [person("p2")]), lookOfAvatar(defaultAvatar("p2")));
  });

  it("keeps the colour and accessory of an agent with no person, and varies skin and hair by its id", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `session-${i}`);
    for (const id of ids) {
      const look = lookOfAgent({ id }, []);
      const style = characterStyle(id);
      assert.equal(look.outfitColor, CHARACTER_COLORS[style.color]);
      assert.equal(look.accessory, style.accessory);
      assert.equal(look.skin, SKIN[defaultAvatar(id).skin]);
    }
    assert.ok(new Set(ids.map((id) => lookOfAgent({ id }, []).skin)).size > 2, "not everyone has the same skin");
    assert.ok(new Set(ids.map((id) => lookOfAgent({ id }, []).hair)).size > 3, "not everyone has the same hair");
  });

  it("treats a person that is no longer on the team like an agent with no person", () => {
    assert.deepEqual(lookOfAgent({ id: "a", personId: "gone" }, [person("p1")]), lookOfAgent({ id: "a" }, []));
  });
});

describe("the shapes of hair and outfit", () => {
  const whiteOnly = (g: NonNullable<ReturnType<typeof hairGeometry>>) => {
    const c = g.getAttribute("color");
    return Array.from(c.array).every((v) => v === 1);
  };

  it("has hair for every style but one, in white so the hair colour tints it", () => {
    const shapes = Array.from({ length: AVATAR_PARTS.hair }, (_, i) => hairGeometry(i));
    assert.equal(shapes.filter((g) => g === null).length, 1, "only the bald style has none");
    for (const g of shapes) if (g) assert.ok(g.getAttribute("position").count > 0 && whiteOnly(g));
  });

  it("has an outfit detail for every style but the plain T-shirt, and tints only the ones made in white", () => {
    const shapes = Array.from({ length: AVATAR_PARTS.outfit }, (_, i) => outfitGeometry(i));
    assert.equal(shapes.filter((g) => g === null).length, 1);
    shapes.forEach((g, i) => {
      if (!g) return;
      const white = whiteOnly(g);
      assert.equal(OUTFIT_TINTED[i], white, `style ${i}: tinted exactly when the shape is white`);
    });
  });
});
