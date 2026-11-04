// Looks at the office in a real browser. Run with:  node tools/browser/check-office.ts <output folder> [scenario...]
// Scenarios: shots (screenshots), perf (frame rate and draw calls), reduced (reduced motion), click (picking), all
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, type Page } from "./cdp.ts";
import { startServer, stopAllServers, until } from "./server.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/browser/check-office.ts <output folder> [shots|narrow|perf|reduced|click|walk|all]");
const wanted = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["all"]);
const run = (name: string) => wanted.has("all") || wanted.has(name);
mkdirSync(out, { recursive: true });

type Stats = { fps: number; cpuMs: number; calls: number; triangles: number };

let failed = false;
const expectSelected = (ok: boolean) => {
  if (!ok) failed = true;
};

let base = "";

async function open(page: Page, agents: number) {
  const server = await startServer();
  base = server.base;
  await page.goto(`${base}/api/session?t=${server.token}`); // sets the cookie, redirects to /
  await page.goto(`${base}/?demo=${agents}`);
  await until(async () => Boolean(await page.evaluate("window.__office")), 20000, "the demo office to draw");
  await page.wait(1500);
}

async function stats(page: Page, seconds = 4): Promise<Stats> {
  await page.wait(seconds * 1000);
  return page.evaluate<Stats>("window.__office");
}

try {
  if (run("shots")) {
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.emulate({ scheme: "light", reducedMotion: false });
    await open(page, 20);
    await page.screenshot(join(out, "demo20-light-1440.png"));
    await page.emulate({ scheme: "dark" });
    await page.wait(600);
    await page.screenshot(join(out, "demo20-dark-1440.png"));
    await page.emulate({ scheme: "light" });
    await page.goto(`${base}/?demo=60`);
    await page.wait(3000);
    await page.screenshot(join(out, "demo60-light-1440.png"));
    console.log("shots: problems =", JSON.stringify(page.problems()));
    await close();
  }

  if (run("narrow")) {
    for (const mobile of [false, true]) {
      const { page, close } = await launchBrowser({ width: 375, height: 800 });
      await page.viewport(375, 800, mobile);
      await open(page, 20);
      await page.screenshot(join(out, `demo20-375-${mobile ? "mobile" : "desktop"}.png`));
      console.log(`narrow(${mobile ? "mobile" : "desktop"}):`, JSON.stringify(await page.evaluate("window.__office")), JSON.stringify(page.problems()));
      await close();
    }
  }

  if (run("click")) {
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await open(page, 20);
    // Tags show only for the focused room's agents (or the hovered and selected one): focus a room first.
    await page.evaluate(`document.querySelector(".room-head-row button")?.click()`);
    await page.wait(1500);
    // A name tag sits just above its character: click a little below its centre.
    const spot = await page.evaluate<{ x: number; y: number; name: string; id: string } | null>(`(() => {
      const tag = [...document.querySelectorAll(".office-tag")].find((t) => t.style.display !== "none");
      if (!tag) return null;
      const r = tag.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.bottom + 70, name: tag.querySelector(".tag-name")?.textContent ?? "", id: "" };
    })()`);
    console.log("click: tag found =", JSON.stringify(spot));
    expectSelected(spot !== null);
    if (spot) {
      // The character is somewhere below its tag; the scale depends on the view, so try a few offsets.
      let result = { bar: "", pressed: "", tag: "" };
      for (const dy of [14, 24, 34, 46, 60]) {
        await page.click(spot.x, spot.y - 70 + dy);
        await page.wait(400);
        result = await page.evaluate(`({
          bar: document.querySelector(".panel h2")?.textContent ?? "",
          pressed: document.querySelector("button.row-name[aria-pressed='true']")?.textContent ?? "",
          tag: document.querySelector(".office-tag[data-state='selected'] .tag-name")?.textContent ?? "",
        })`);
        if (result.pressed !== "") break;
      }
      console.log("click: after click =", JSON.stringify(result));
      expectSelected(result.pressed !== "" && result.pressed === result.bar);
      await page.screenshot(join(out, "selected-1440.png"));
    }
    console.log("click: problems =", JSON.stringify(page.problems()));
    await close();
  }

  if (run("walk")) {
    for (const reduced of [false, true]) {
      const { page, close } = await launchBrowser({ width: 1440, height: 900 });
      await page.viewport(1440, 900);
      await page.emulate({ scheme: "light", reducedMotion: reduced });
      await open(page, 20);
      let maxWalkers = 0;
      let maxBubbles = 0;
      let shots = 0;
      let sawBubbleText = "";
      for (let i = 0; i < 160 && (shots < 3 || maxBubbles === 0); i++) {
        const now = await page.evaluate<{ walkers: number; bubbles: string[] }>(`({ walkers: Number(document.documentElement.dataset.walkers || 0), bubbles: [...document.querySelectorAll(".office-bubble")].filter((b) => b.style.display !== "none").map((b) => b.textContent) })`);
        maxWalkers = Math.max(maxWalkers, now.walkers);
        maxBubbles = Math.max(maxBubbles, now.bubbles.length);
        if (now.bubbles[0]) sawBubbleText = now.bubbles[0];
        if (!reduced && now.walkers > 0 && shots < 3 && i % 3 === 0) await page.screenshot(join(out, `walk-${shots++}.png`));
        if (reduced && now.bubbles.length > 0 && shots < 1) {
          await page.screenshot(join(out, "walk-reduced.png"));
          shots++;
        }
        await page.wait(250);
      }
      if (!reduced) {
        // Close up, to look at the figures themselves.
        await page.evaluate(`document.querySelector(".room-head-row button")?.click()`);
        await page.wait(1500);
        let zoomed = 0;
        for (let i = 0; i < 160 && zoomed < 3; i++) {
          const walkers = await page.evaluate<number>(`Number(document.documentElement.dataset.walkers || 0)`);
          if (walkers > 0) await page.screenshot(join(out, `walk-zoom-${zoomed++}.png`));
          await page.wait(350);
        }
      }
      console.log(`walk(reduced=${reduced}): max walkers ${maxWalkers}, max bubbles ${maxBubbles}, shots ${shots}, example bubble: ${JSON.stringify(sawBubbleText)}, problems ${JSON.stringify(page.problems().filter((p) => !p.includes("THREE.Clock")))}`);
      if (reduced ? maxWalkers !== 0 : maxWalkers < 1 || maxWalkers > 4) failed = true;
      if (maxBubbles < 1 || maxBubbles > 4) failed = true;
      await close();
    }
  }

  if (run("reduced")) {
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.emulate({ scheme: "light", reducedMotion: true });
    await open(page, 20);
    await page.screenshot(join(out, "reduced-a.png"));
    await page.wait(1200);
    await page.screenshot(join(out, "reduced-b.png"));
    console.log("reduced: (compare reduced-a.png and reduced-b.png) problems =", JSON.stringify(page.problems()));
    await close();
  }

  if (run("perf")) {
    for (const agents of [20, 48]) {
      for (const mode of ["gpu", "software+4xcpu"] as const) {
        const { page, close } = await launchBrowser({ width: 1440, height: 900, uncapped: mode === "gpu", software: mode !== "gpu" });
        if (mode !== "gpu") await page.cpuThrottle(4);
        await open(page, agents);
        const s = await stats(page, mode === "gpu" ? 5 : 8);
        console.log(`perf: ${agents} agents, ${mode}: ${JSON.stringify(s)} problems=${page.problems().length}`);
        await close();
      }
    }
  }
} finally {
  stopAllServers();
}
if (failed) {
  console.error("FAILED: a click did not select, or walking/bubbles were out of bounds");
  process.exitCode = 1;
}
