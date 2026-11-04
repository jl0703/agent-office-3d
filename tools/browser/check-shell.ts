// Looks at the page around the office in a real browser. Run with:
//   node tools/browser/check-shell.ts <output folder> [shots|states|axe|keys|touch|fonts|all]
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, type Page } from "./cdp.ts";
import { startServer, stopAllServers, until } from "./server.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/browser/check-shell.ts <output folder> [shots|states|axe|keys|touch|fonts|all]");
const wanted = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["all"]);
const run = (name: string) => wanted.has("all") || wanted.has(name);
mkdirSync(out, { recursive: true });

const SIZES = [
  [1440, 900],
  [1024, 768],
  [768, 1024],
  [375, 800],
] as const;

const failures: string[] = [];
const expect = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

async function login(page: Page) {
  const server = await startServer();
  await page.goto(`${server.base}/api/session?t=${server.token}`);
  return server;
}

async function demo(page: Page, base: string, agents = 20) {
  await page.goto(`${base}/?demo=${agents}`);
  await until(async () => Boolean(await page.evaluate("window.__office")), 20000, "the office to draw");
  await page.wait(800);
}

const selectFirst = (page: Page) => page.evaluate(`document.querySelector("button.row-name")?.click()`);
const describe = `(() => { const e = document.activeElement; if (!e) return "none"; const name = e.getAttribute("aria-label") || e.textContent?.trim().slice(0, 40) || ""; return e.tagName.toLowerCase() + (e.getAttribute("role") ? "[" + e.getAttribute("role") + "]" : "") + ' "' + name + '"'; })()`;

try {
  if (run("shots")) {
    for (const scheme of ["light", "dark"] as const) {
      const { page, close } = await launchBrowser({ width: 1440, height: 900 });
      await page.emulate({ scheme, reducedMotion: false });
      const server = await login(page);
      for (const [w, h] of SIZES) {
        await page.viewport(w, h);
        await demo(page, server.base);
        await page.screenshot(join(out, `shell-${w}-${scheme}-office.png`));
        if (w <= 600) {
          await page.evaluate(`document.getElementById("tab-list")?.click()`);
          await page.wait(300);
          await page.screenshot(join(out, `shell-${w}-${scheme}-list.png`));
          await page.evaluate(`document.getElementById("tab-office")?.click()`);
          await page.wait(300);
        }
        await selectFirst(page);
        await page.wait(600);
        await page.screenshot(join(out, `shell-${w}-${scheme}-selected.png`));
        if (w <= 600) {
          await page.evaluate(`document.querySelector(".peek")?.click()`);
          await page.wait(500);
          await page.screenshot(join(out, `shell-${w}-${scheme}-panel.png`));
        }
      }
      console.log(`shots(${scheme}): problems =`, JSON.stringify(page.problems().filter((p) => !p.includes("THREE.Clock"))));
      await close();
    }
  }

  if (run("states")) {
    // Empty: the real server with nothing to show. Disconnected: the same page after the server stops.
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.emulate({ scheme: "light" });
    const server = await login(page);
    await page.goto(`${server.base}/`);
    await until(async () => (await page.evaluate<string>(`document.querySelector(".office-empty h2")?.textContent ?? ""`)) !== "", 15000, "the empty state");
    await page.screenshot(join(out, "state-empty.png"));
    console.log("states: empty ->", await page.evaluate(`document.querySelector(".office-empty")?.textContent`));
    server.stop();
    await until(async () => (await page.evaluate<string>(`document.querySelector(".connection")?.textContent ?? ""`)).includes("Disconnected"), 20000, "the disconnected badge");
    await page.wait(500);
    await page.screenshot(join(out, "state-disconnected.png"));
    console.log("states: disconnected ->", await page.evaluate(`JSON.stringify({ badge: document.querySelector(".connection")?.textContent, banner: document.querySelector(".stale-banner")?.textContent, startOff: document.querySelector(".form-message")?.textContent, stopAllDisabled: [...document.querySelectorAll(".app-actions button")].find(b => b.textContent.includes("Stop all"))?.disabled })`));
    await close();

    const plain = await launchBrowser({ width: 1440, height: 900, noWebgl: true });
    const second = await login(plain.page);
    await plain.page.goto(`${second.base}/?demo=20`);
    await plain.page.wait(1500);
    await plain.page.screenshot(join(out, "state-no-webgl.png"));
    console.log("states: no-webgl ->", await plain.page.evaluate(`document.querySelector(".office-notice")?.textContent ?? "(notice not shown)"`));
    await plain.close();
  }

  if (run("axe")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    for (const scheme of ["light", "dark"] as const) {
      for (const [w, h] of [SIZES[0], SIZES[3]]) {
        const { page, close } = await launchBrowser({ width: w, height: h });
        await page.emulate({ scheme });
        await page.viewport(w, h);
        const server = await login(page);
        await demo(page, server.base);
        await selectFirst(page);
        await page.wait(600);
        await page.evaluate(source);
        const result = await page.evaluate<{ id: string; impact: string; help: string; nodes: string[] }[]>(
          `axe.run(document, { resultTypes: ["violations"] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map(n => n.target.join(" ")) })))`,
        );
        const bad = result.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(bad.length === 0, `axe ${scheme} ${w}px: ${bad.map((v) => v.id).join(", ")}`);
        console.log(`axe ${scheme} ${w}px: ${result.length} violations, ${bad.length} serious/critical`, JSON.stringify(result));
        await close();
      }
    }
  }

  if (run("keys")) {
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.viewport(1440, 900);
    const server = await login(page);
    await demo(page, server.base);
    await page.evaluate(`document.body.focus(); document.activeElement && document.activeElement.blur()`);
    const path: string[] = [];
    for (let i = 0; i < 14; i++) {
      await page.key("Tab", { keyCode: 9 });
      path.push(await page.evaluate<string>(describe));
    }
    console.log("keys: tab path:\n  " + path.join("\n  "));
    // Into the list: focus the first row, arrow down twice, Enter selects, Escape closes and focus returns.
    await page.evaluate(`document.querySelector("button.row-name").focus()`);
    await page.key("ArrowDown", { keyCode: 40 });
    await page.key("ArrowDown", { keyCode: 40 });
    const onRow = await page.evaluate<string>(describe);
    await page.key("Enter", { keyCode: 13 });
    await page.wait(400);
    const state = await page.evaluate<string>(`JSON.stringify({ focus: ${describe}, docked: matchMedia("(min-width: 1440px)").matches, width: innerWidth, panel: document.querySelector(".panel h2")?.textContent })`);
    await page.key("Escape", { keyCode: 27 });
    await page.wait(400);
    const after = await page.evaluate<string>(`JSON.stringify({ focus: ${describe}, panelOpen: Boolean(document.querySelector(".panel")) })`);
    console.log("keys: arrows ->", onRow, "| enter ->", state, "| escape ->", after);
    expect(state.includes('"focus":"button') && state.includes('"panel":"') && after.includes('"panelOpen":false') && after.includes('"focus":"button'), "keys: select with Enter, close with Escape, focus back on the row");
    // Stop all asks first: it is disabled in demo, so check on the confirmation with a forced enable.
    console.log("keys: roving tab stops =", await page.evaluate(`document.querySelectorAll("button.row-name[tabindex='0']").length`));
    await close();

    // Phone: the tab strip works from the keyboard.
    const phone = await launchBrowser({ width: 375, height: 800 });
    await phone.page.viewport(375, 800, true);
    const phoneServer = await login(phone.page);
    await demo(phone.page, phoneServer.base);
    await phone.page.evaluate(`document.getElementById("tab-office").focus()`);
    await phone.page.key("ArrowRight", { keyCode: 39 });
    await phone.page.wait(300);
    const tabs = await phone.page.evaluate<string>(`JSON.stringify({ list: document.getElementById("tab-list").getAttribute("aria-selected"), focus: ${describe} })`);
    console.log("keys: phone ArrowRight on tabs ->", tabs);
    expect(tabs.includes('"list":"true"'), "keys: ArrowRight on the Office tab selects the List tab");
    await phone.close();
  }

  if (run("touch")) {
    const { page, close } = await launchBrowser({ width: 375, height: 800 });
    await page.viewport(375, 800, true);
    const server = await login(page);
    await demo(page, server.base);
    const small = async (label: string) => {
      const r = await page.evaluate<string[]>(
        `[...document.querySelectorAll("button, summary, [role=tab], input, textarea")].filter(e => e.offsetParent !== null).map(e => { const b = e.getBoundingClientRect(); return { n: (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 30), w: Math.round(b.width), h: Math.round(b.height) }; }).filter(x => x.h < 44 || x.w < 44).map(x => x.n + " " + x.w + "x" + x.h)`,
      );
      expect(r.length === 0, `touch(${label}): ${r.join("; ")}`);
      console.log(`touch(${label}): ${r.length} controls under 44px`, JSON.stringify(r));
    };
    await small("office tab");
    await page.evaluate(`document.getElementById("tab-list")?.click()`);
    await page.wait(300);
    await small("list tab");
    await close();
  }

  if (run("fonts")) {
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    const server = await login(page);
    await demo(page, server.base);
    await page.wait(500);
    const families = await page.evaluate<string>(
      `JSON.stringify({ h1: getComputedStyle(document.querySelector("h1")).fontFamily, body: getComputedStyle(document.body).fontFamily, mono: getComputedStyle(document.querySelector(".activity")).fontFamily, loaded: [...document.fonts].filter(f => f.status === "loaded").map(f => f.family + " " + f.weight) })`,
    );
    console.log("fonts:", families);
    const foreign = page.requests().filter((u) => !u.startsWith(server.base) && !u.startsWith("data:") && !u.startsWith("blob:"));
    console.log("fonts: requests to other origins =", JSON.stringify(foreign));
    await close();
  }
} finally {
  stopAllServers();
}
if (failures.length > 0) {
  console.error("FAILED:", ...failures);
  process.exitCode = 1;
}
