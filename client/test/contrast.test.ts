import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/theme/tokens.css", import.meta.url), "utf8");

/** The custom properties declared in the first `:root` block (light) or the one inside the dark media query. */
function tokens(scheme: "light" | "dark"): Record<string, string> {
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? "";
  const light = /^:root \{([^}]*)\}/m.exec(css)?.[1] ?? "";
  const read = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]));
  return scheme === "light" ? read(light) : { ...read(light), ...read(dark) };
}

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT_ON = ["canvas", "surface", "surface-2"] as const;
const STATUSES = ["working", "idle", "waiting", "done", "stopped", "error", "detached"];
const KINDS = ["master", "build"];

for (const scheme of ["light", "dark"] as const) {
  const t = tokens(scheme);
  const at = (name: string) => t[name] ?? assert.fail(`missing token --${name} in ${scheme}`);

  test(`${scheme}: text, muted text, accent and selection are at least 4.5:1 on every background`, () => {
    for (const bg of TEXT_ON) {
      for (const fg of ["text", "text-muted", "accent", "selection"]) {
        const ratio = contrast(at(`color-${fg}`), at(`color-${bg}`));
        assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${scheme}: every status colour is at least 4.5:1 on surface and canvas`, () => {
    for (const status of STATUSES) {
      for (const bg of ["surface", "canvas"]) {
        const ratio = contrast(at(`status-${status}`), at(`color-${bg}`));
        assert.ok(ratio >= 4.5, `${status} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${scheme}: the colours of the board (columns, kinds and tones) are at least 4.5:1 on the cards and the page`, () => {
    for (const name of [...STATUSES.map((s) => `status-${s}`), ...KINDS.map((k) => `kind-${k}`), "color-accent"]) {
      for (const bg of ["surface", "canvas"]) {
        const ratio = contrast(at(name), at(`color-${bg}`));
        assert.ok(ratio >= 4.5, `${name} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${scheme}: borders and the focus ring are at least 3:1 on surface and canvas`, () => {
    for (const bg of ["surface", "canvas"]) {
      for (const fg of ["border", "focus"]) {
        const ratio = contrast(at(`color-${fg}`), at(`color-${bg}`));
        assert.ok(ratio >= 3, `${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
  });
}

test("the contrast function matches known values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(1), "21.0");
  assert.equal(contrast("#777777", "#777777").toFixed(1), "1.0");
});
