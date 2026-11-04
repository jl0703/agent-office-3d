// Looks at the office in a real browser. Run with:  node tools/browser/check-office.ts <output folder> [scenario...]
// Scenarios: shots (screenshots), perf (frame rate and draw calls), reduced (reduced motion), click (picking), all
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, type Page } from "./cdp.ts";
import { startServer, stopAllServers, until } from "./server.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/browser/check-office.ts <output folder> [shots|narrow|perf|reduced|click|all]");
const wanted = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["all"]);
const run = (name: string) => wanted.has("all") || wanted.has(name);
mkdirSync(out, { recursive: true });

type Stats = { fps: number; cpuMs: number; calls: number; triangles: number };

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
    // A name tag sits just above its character: click a little below its centre.
    const spot = await page.evaluate<{ x: number; y: number; name: string; id: string } | null>(`(() => {
      const tag = [...document.querySelectorAll(".office-tag")].find((t) => t.style.display !== "none");
      if (!tag) return null;
      const r = tag.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.bottom + 70, name: tag.querySelector(".tag-name")?.textContent ?? "", id: "" };
    })()`);
    console.log("click: tag found =", JSON.stringify(spot));
    if (spot) {
      await page.move(spot.x, spot.y);
      await page.wait(300);
      const hover = await page.evaluate<string>(`document.querySelector(".office-tag[data-state='hover']")?.querySelector(".tag-name")?.textContent ?? ""`);
      await page.click(spot.x, spot.y);
      await page.wait(500);
      const selected = await page.evaluate<{ bar: string; pressed: string; tag: string }>(`({
        bar: document.querySelector(".panel h2")?.textContent ?? "",
        pressed: document.querySelector("button[aria-pressed='true']")?.textContent ?? "",
        tag: document.querySelector(".office-tag[data-state='selected'] .tag-name")?.textContent ?? "",
      })`);
      console.log("click: hovered tag =", JSON.stringify(hover), "| after click =", JSON.stringify(selected));
      await page.screenshot(join(out, "selected-1440.png"));
      await page.click(8, 8); // empty page area: nothing changes
    }
    console.log("click: problems =", JSON.stringify(page.problems()));
    await close();
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
