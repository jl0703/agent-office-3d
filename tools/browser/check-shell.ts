// Looks at the page around the office in a real browser. Run with:
//   node tools/browser/check-shell.ts <output folder> [shots|states|rooms|needs|panel|filter|research|axe|keys|touch|fonts|all]
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, type Page } from "./cdp.ts";
import { startServer, stopAllServers, until } from "./server.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/browser/check-shell.ts <output folder> [shots|states|rooms|needs|panel|filter|research|axe|keys|touch|fonts|all]");
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

  if (run("rooms")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    for (const scheme of ["light", "dark"] as const) {
      const { page, close } = await launchBrowser({ width: 1440, height: 900 });
      await page.emulate({ scheme });
      await page.viewport(1440, 900);
      const server = await login(page);
      await demo(page, server.base);
      const count = (selector: string) => page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
      const signs = await count(".room-sign:not(.hub-sign)");
      const groupsBefore = await count(".room-head");
      expect(signs >= 3, `rooms(${scheme}): room signs shown (${signs})`);
      await page.screenshot(join(out, `rooms-${scheme}-overview.png`));
      await page.evaluate(`document.querySelector(".room-sign:not(.hub-sign)").click()`);
      await page.wait(900);
      const groupsFocused = await count(".room-head");
      const overview = await page.evaluate<boolean>(`[...document.querySelectorAll(".app-actions button")].some((b) => b.textContent.includes("Overview"))`);
      expect(groupsFocused === 1 && groupsBefore > 1, `rooms(${scheme}): focusing a room filters the list (${groupsBefore} -> ${groupsFocused})`);
      expect(overview, `rooms(${scheme}): Overview button appears`);
      await page.screenshot(join(out, `rooms-${scheme}-focused.png`));
      await page.key("Escape", { keyCode: 27 });
      await page.wait(900);
      expect((await count(".room-head")) === groupsBefore, `rooms(${scheme}): Escape returns to the overview`);
      expect((await page.evaluate<string>(`document.querySelector(".hub-new")?.textContent ?? ""`)).includes("new finding"), `rooms(${scheme}): hub sign shows new findings`);
      await page.evaluate(`document.querySelector(".hub-sign").click()`);
      await page.wait(500);
      const hub = await page.evaluate<string>(`document.querySelector(".panel")?.textContent ?? ""`);
      expect(hub.includes("Knowledge hub") && hub.includes("Demo vault") && hub.includes("60 notes"), `rooms(${scheme}): hub panel shows the vault`);
      await page.evaluate(`(() => { const i = document.querySelector(".panel input[type=search]"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "note 7"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await page.wait(300);
      const links = await page.evaluate<string[]>(`[...document.querySelectorAll("[aria-label='Matching notes'] a")].map((a) => a.getAttribute("href"))`);
      expect(links.length > 0 && links.every((h) => h.startsWith("obsidian://open?vault=Demo%20vault&file=")), `rooms(${scheme}): search finds notes with obsidian links (${links.length})`);
      await page.screenshot(join(out, `rooms-${scheme}-hub.png`));
      await page.evaluate(source);
      const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact))`);
      expect(violations.length === 0, `rooms(${scheme}): axe with the hub open: ${violations.join(", ")}`);
      console.log(`rooms(${scheme}): signs=${signs} groups ${groupsBefore}->${groupsFocused} links=${links.length} axe=${violations.length} problems=${JSON.stringify(page.problems().filter((x) => !x.includes("THREE.Clock")))}`);
      await close();
    }
    const big = await launchBrowser({ width: 1440, height: 900 });
    await big.page.viewport(1440, 900);
    const bigServer = await login(big.page);
    await demo(big.page, bigServer.base, 60);
    const chip = await big.page.evaluate<string>(`document.querySelector(".office-chip")?.textContent ?? ""`);
    expect(chip.includes("more"), "rooms: 60 agents show the overflow chip");
    await big.page.screenshot(join(out, "rooms-60.png"));
    console.log("rooms: 60 agents chip =", chip);
    await big.close();
  }

  if (run("needs")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.viewport(1440, 900);
    const server = await login(page);
    await demo(page, server.base);
    await page.wait(2500); // the demo changes statuses every few seconds: let something need attention
    const title = await page.evaluate<string>("document.title");
    expect(/^\(\d+\) \[Demo\] Agent Office$/.test(title) || title === "[Demo] Agent Office", `needs: page title ${title}`);
    await page.evaluate(`[...document.querySelectorAll(".app-actions button")].find((b) => b.textContent.includes("Needs you"))?.click()`);
    await page.wait(300);
    const rows = await page.evaluate<number>(`document.querySelectorAll(".needs-list li button").length`);
    const empty = await page.evaluate<boolean>(`Boolean(document.querySelector(".needs-list p"))`);
    expect(rows > 0 || empty, "needs: the list opens");
    await page.screenshot(join(out, "needs-open.png"));
    await page.evaluate(source);
    const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact))`);
    expect(violations.length === 0, `needs: axe with the list open: ${violations.join(", ")}`);
    if (rows > 0) {
      await page.evaluate(`document.querySelector(".needs-list li button").click()`);
      await page.wait(500);
      const opened = await page.evaluate<string>(`document.querySelector(".panel h2")?.textContent ?? ""`);
      expect(opened !== "", "needs: choosing an item opens its details");
    }
    await page.key("Escape", { keyCode: 27 });
    console.log(`needs: title=${JSON.stringify(title)} rows=${rows} axe=${violations.length}`);
    await close();
  }

  if (run("panel")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.viewport(1440, 900);
    const server = await login(page);
    await demo(page, server.base);
    await page.wait(3000);
    await selectFirst(page);
    await page.wait(600);
    const teamBefore = await page.evaluate<string[]>(`[...document.querySelectorAll(".team li button")].map((b) => b.textContent)`);
    const rows = await page.evaluate<string[]>(`[...document.querySelectorAll(".timeline li")].map((li) => li.querySelector("time")?.textContent + " | " + li.querySelector(".mono")?.textContent)`);
    expect(teamBefore.length >= 2, `panel: team lists the lead and its workers (${teamBefore.length})`);
    expect(rows.length >= 1 && rows.every((r) => /(just now|ago| \d{4}|\d+\/\d+\/\d+)/.test(r)), `panel: timeline rows with relative times (${rows.length})`);
    await page.screenshot(join(out, "panel-team-timeline.png"));
    const before = await page.evaluate<string>(`document.querySelector(".panel h2")?.textContent ?? ""`);
    await page.evaluate(`document.querySelectorAll(".team li button")[1]?.click()`);
    await page.wait(500);
    const after = await page.evaluate<string>(`document.querySelector(".panel h2")?.textContent ?? ""`);
    expect(after !== before, "panel: choosing a team member opens its details");
    await page.evaluate(source);
    const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact))`);
    expect(violations.length === 0, `panel: axe: ${violations.join(", ")}`);
    console.log(`panel: team=${teamBefore.length} timeline=${rows.length} sample=${JSON.stringify(rows[0])} axe=${violations.length}`);
    await close();
  }

  if (run("filter")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    const { page, close } = await launchBrowser({ width: 1440, height: 900 });
    await page.viewport(1440, 900);
    const server = await login(page);
    await demo(page, server.base);
    const rows = () => page.evaluate<number>(`document.querySelectorAll("button.row-name").length`);
    const all = await rows();
    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await page.key("/", { keyCode: 191 });
    await page.wait(300);
    const focused = await page.evaluate<string>(`document.activeElement?.id ?? ""`);
    expect(focused === "session-search", `filter: "/" focuses the search (${focused})`);
    await page.evaluate(`(() => { const i = document.getElementById("session-search"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "docs"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await page.wait(300);
    const some = await rows();
    const status = await page.evaluate<string>(`document.querySelector(".list-filter [role=status]")?.textContent ?? ""`);
    expect(some > 0 && some < all, `filter: search narrows the list (${all} -> ${some})`);
    expect(/\d+ of \d+ sessions/.test(status), `filter: result count announced ("${status}")`);
    await page.key("Escape", { keyCode: 27 });
    await page.wait(300);
    const cleared = await rows();
    expect(cleared === all, `filter: Escape clears the search (${cleared} of ${all})`);
    await page.evaluate(`document.querySelector(".chip-filter")?.click()`);
    await page.wait(300);
    const byStatus = await rows();
    const pressed = await page.evaluate<number>(`document.querySelectorAll(".chip-filter[aria-pressed=true]").length`);
    expect(pressed === 1 && byStatus > 0 && byStatus <= all, `filter: a status chip narrows the list (${byStatus})`);
    await page.evaluate(`document.querySelector("[aria-label='Clear search and filters']")?.click()`);
    await page.wait(300);
    expect((await rows()) === all, "filter: Clear restores the list");
    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await page.key("j", { keyCode: 74 });
    const onRow = await page.evaluate<boolean>(`document.activeElement?.classList.contains("row-name") ?? false`);
    expect(onRow, "filter: j moves to a session");
    await page.evaluate(`document.querySelector(".legend summary")?.click()`);
    await page.wait(200);
    await page.screenshot(join(out, "filter-legend.png"));
    await page.evaluate(source);
    const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact))`);
    expect(violations.length === 0, `filter: axe: ${violations.join(", ")}`);
    console.log(`filter: rows ${all} -> search ${some} -> chip ${byStatus}, status="${status}", axe=${violations.length}`);
    await close();
  }

  if (run("research")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    for (const scheme of ["light", "dark"] as const) {
      const { page, close } = await launchBrowser({ width: 1440, height: 900 });
      await page.emulate({ scheme });
      await page.viewport(1440, 900);
      const server = await login(page);
      await demo(page, server.base);
      await page.evaluate(`[...document.querySelectorAll(".app-actions button")].find((b) => b.textContent.includes("Research"))?.click()`);
      await page.wait(600);
      const cards = await page.evaluate<number>(`document.querySelectorAll(".finding").length`);
      expect(cards === 4, `research(${scheme}): board shows the demo findings (${cards})`);
      expect((await page.evaluate<string>(`document.querySelector(".finding")?.textContent ?? ""`)).includes("Improves: code-reviewer skill"), `research(${scheme}): a finding says what it improves`);
      expect((await page.evaluate<string>(`document.querySelector(".fit")?.textContent ?? ""`)).includes("Fit check: Fits"), `research(${scheme}): a looked-at finding shows its fit check`);
      await page.screenshot(join(out, `research-${scheme}.png`));
      // Judge a finding: Looking, then hand it to a master.
      await page.evaluate(`document.querySelector(".finding .decisions button:nth-child(2)")?.click()`);
      await page.wait(300);
      const pressed = await page.evaluate<number>(`document.querySelectorAll(".finding .decisions button[aria-pressed=true]").length`);
      expect(pressed === 4, `research(${scheme}): each card shows its decision (${pressed})`);
      const hand = await page.evaluate<boolean>(`Boolean([...document.querySelectorAll(".finding button")].find((b) => b.textContent.includes("Hand to a master")))`);
      expect(hand, `research(${scheme}): a finding being looked at can be handed to a master`);
      const links = await page.evaluate<string[]>(`[...document.querySelectorAll(".finding h3 a")].map((a) => a.rel + " " + a.target)`);
      expect(links.length > 0 && links.every((l) => l.includes("noopener") && l.includes("_blank")), `research(${scheme}): links open safely`);
      await page.evaluate(source);
      const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact + " " + v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " :: " + (n.any[0] && n.any[0].message || "")).join(" | ")))`);
      expect(violations.length === 0, `research(${scheme}): axe: ${violations.join(", ")}`);
      console.log(`research(${scheme}): cards=${cards} pressed=${pressed} axe=${violations.length}`);
      await close();
    }
  }

  if (run("plan")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    for (const [scheme, w, h] of [["light", 1440, 900], ["dark", 375, 740]] as const) {
      const { page, close } = await launchBrowser({ width: w, height: h });
      await page.emulate({ scheme });
      await page.viewport(w, h);
      const server = await login(page);
      await demo(page, server.base);
      await page.evaluate(`[...document.querySelectorAll(".app-actions button")].find((b) => (b.getAttribute("aria-label") || b.textContent).includes("Needs you"))?.click()`);
      await page.wait(300);
      const listed = await page.evaluate<boolean>(`document.querySelector(".needs-list")?.textContent.includes("Plan to approve") ?? false`);
      expect(listed, `plan(${scheme}): the plan is listed under Needs you`);
      await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Plan to approve"))?.click()`);
      await page.wait(500);
      await page.evaluate(`document.querySelector(".peek")?.click()`);
      await page.wait(500);
      const card = await page.evaluate<string>(`JSON.stringify({ card: Boolean(document.querySelector(".plan-card")), steps: document.querySelectorAll(".plan-card li").length, buttons: [...document.querySelectorAll(".plan-card .decisions button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")) })`);
      expect(card.includes('"card":true') && card.includes('"steps":4'), `plan(${scheme}): card with its steps ${card}`);
      await page.screenshot(join(out, `plan-${scheme}.png`));
      await page.evaluate(source);
      const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact + " " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")))`);
      expect(violations.length === 0, `plan(${scheme}): axe: ${violations.join(", ")}`);
      console.log(`plan(${scheme}): ${card} axe=${violations.length}`);
      await close();
    }
  }

  if (run("pastruns")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    for (const [scheme, w, h] of [["light", 1440, 900], ["dark", 375, 740]] as const) {
      const { page, close } = await launchBrowser({ width: w, height: h });
      await page.emulate({ scheme });
      await page.viewport(w, h);
      const server = await login(page);
      await demo(page, server.base);
      await page.evaluate(`document.querySelector("[data-hub-button]")?.click()`);
      await page.wait(600);
      await page.evaluate(`document.querySelector(".peek")?.click()`);
      await page.wait(400);
      const info = await page.evaluate<string>(`JSON.stringify({ runs: document.querySelectorAll(".past-runs > li").length, filter: Boolean(document.querySelector(".panel select")) })`);
      expect(info.includes('"runs":2') && info.includes('"filter":true'), `pastruns(${scheme}): runs listed with a project filter ${info}`);
      await page.evaluate(`document.querySelector(".past-runs summary")?.click()`);
      await page.wait(200);
      const again = await page.evaluate<boolean>(`Boolean([...document.querySelectorAll(".past-runs button")].find((b) => b.textContent.includes("Plan again like this")))`);
      expect(again, `pastruns(${scheme}): a run can be planned again`);
      await page.screenshot(join(out, `pastruns-${scheme}.png`));
      await page.evaluate(source);
      const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact + " " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")))`);
      expect(violations.length === 0, `pastruns(${scheme}): axe: ${violations.join(", ")}`);
      console.log(`pastruns(${scheme}): ${info} axe=${violations.length}`);
      await close();
    }
  }

  if (run("workshop")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    for (const [scheme, w, h] of [["light", 1440, 900], ["dark", 375, 740]] as const) {
      const { page, close } = await launchBrowser({ width: w, height: h });
      await page.emulate({ scheme });
      await page.viewport(w, h);
      const server = await login(page);
      await demo(page, server.base);
      await page.evaluate(`document.querySelector("[data-workshop-button]")?.click()`);
      await page.wait(600);
      await page.evaluate(`document.querySelector(".peek")?.click()`);
      await page.wait(400);
      const builds = await page.evaluate<number>(`document.querySelectorAll(".panel .note-list > li").length`);
      expect(builds === 2, `workshop(${scheme}): two demo builds are listed (${builds})`);
      await page.evaluate(`document.querySelector(".panel details summary")?.click()`);
      await page.wait(400);
      const patch = await page.evaluate<string>(`document.querySelector(".patch")?.textContent ?? ""`);
      expect(patch.includes("+new line") && patch.includes("-old line"), `workshop(${scheme}): the patch is shown`);
      await page.screenshot(join(out, `workshop-${scheme}.png`));
      await page.evaluate(source);
      const violations = await page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact + " " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")))`);
      expect(violations.length === 0, `workshop(${scheme}): axe: ${violations.join(", ")}`);
      console.log(`workshop(${scheme}): builds=${builds} axe=${violations.length}`);
      await close();
    }
  }

  if (run("sidebar")) {
    const source = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    const setter = "(sel, value) => { const i = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, value); i.dispatchEvent(new Event('input', { bubbles: true })); }";
    const axe = async (page: { evaluate<T>(code: string): Promise<T> }) =>
      page.evaluate<string[]>(`axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations.map((v) => v.id + " " + v.impact + " " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")))`);
    for (const [scheme, w, h] of [["light", 1440, 900], ["dark", 375, 740]] as const) {
      const { page, close } = await launchBrowser({ width: w, height: h });
      await page.emulate({ scheme });
      await page.viewport(w, h);
      const server = await login(page);
      await demo(page, server.base);
      // The menu: links to the office and the three pages.
      await page.evaluate(`document.querySelector("[data-sidebar-button]")?.click()`);
      await page.wait(400);
      const links = await page.evaluate<string>(`[...document.querySelectorAll(".drawer nav a")].map((a) => a.textContent.trim() + "=" + a.getAttribute("href")).join(" | ")`);
      expect(links.includes("Skills=#/skills") && links.includes("MCP servers=#/mcp") && links.includes("AI Agents=#/agents") && links.includes("Office=#/"), `sidebar(${scheme}): the menu has links to every page (${links})`);
      await page.evaluate(`[...document.querySelectorAll(".drawer nav a")].find((a) => a.textContent.includes("Skills"))?.click()`);
      await page.wait(500);
      const hash = await page.evaluate<string>(`location.hash`);
      expect(hash === "#/skills", `sidebar(${scheme}): choosing Skills goes to its own page (${hash})`);
      expect(await page.evaluate<boolean>(`!document.querySelector(".drawer")`), `sidebar(${scheme}): the menu closes after choosing`);
      const head = await page.evaluate<string>(`document.querySelector("h1")?.textContent ?? ""`);
      expect(head === "Skills", `sidebar(${scheme}): the page title is Skills (${head})`);
      expect(await page.evaluate<string>(`document.activeElement?.id ?? ""`) === "catalog-title", `sidebar(${scheme}): focus moves to the page title`);
      expect((await page.evaluate<string>(`document.title`)).includes("Skills"), `sidebar(${scheme}): the tab title names the page`);
      const cards = await page.evaluate<number>(`document.querySelectorAll(".catalog-grid .card").length`);
      expect(cards === 3, `sidebar(${scheme}): three demo skill cards (${cards})`);
      const crumbs = await page.evaluate<string>(`document.querySelector(".breadcrumb")?.textContent ?? ""`);
      expect(crumbs.includes("Office") && crumbs.includes("Skills"), `sidebar(${scheme}): breadcrumb shows where you are (${crumbs})`);
      // Sorting and searching.
      const first = () => page.evaluate<string>(`document.querySelector(".catalog-grid .card h2")?.textContent ?? ""`);
      const byName = await first();
      await page.evaluate(`[...document.querySelectorAll(".catalog-tools .chip-filter")].find((b) => b.textContent === "Recent")?.click()`);
      await page.wait(200);
      const byRecent = await first();
      expect(byName === "demo-clean-code" && byRecent === "demo-docs-writer", `sidebar(${scheme}): Recent puts the newest first (${byName} -> ${byRecent})`);
      await page.evaluate(`(() => { const i = document.querySelector(".catalog-search input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "reviews"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await page.wait(200);
      expect((await page.evaluate<number>(`document.querySelectorAll(".catalog-grid .card").length`)) === 1, `sidebar(${scheme}): search narrows the cards`);
      await page.evaluate(`(() => { const i = document.querySelector(".catalog-search input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await page.wait(200);
      // Remove asks first, and Cancel puts focus back.
      await page.evaluate(`document.querySelector("[aria-label='Remove demo-docs-writer']")?.click()`);
      await page.wait(200);
      const confirmText = await page.evaluate<string>(`document.querySelector(".confirm-box")?.textContent ?? ""`);
      expect(confirmText.includes("Change your Claude setup?") && confirmText.includes("demo-docs-writer"), `sidebar(${scheme}): removing asks first (${confirmText})`);
      expect(await page.evaluate<boolean>(`document.activeElement?.closest(".confirm-box") !== null`), `sidebar(${scheme}): focus moves into the confirm box`);
      await page.evaluate(source);
      const listViolations = await axe(page);
      expect(listViolations.length === 0, `sidebar(${scheme}): axe on the skills page with the confirm box open: ${listViolations.join(", ")}`);
      await page.screenshot(join(out, `catalog-${scheme}.png`));
      await page.evaluate(`[...document.querySelectorAll(".confirm-box button")].find((b) => b.textContent === "Cancel")?.click()`);
      await page.wait(300);
      expect(await page.evaluate<string>(`document.activeElement?.getAttribute("aria-label") ?? ""`) === "Remove demo-docs-writer", `sidebar(${scheme}): Cancel returns focus to the button that asked`);
      // A details page, and Back.
      await page.evaluate(`document.querySelector("[aria-label='View details for demo-clean-code']")?.click()`);
      await page.wait(400);
      expect((await page.evaluate<string>(`location.hash`)) === "#/skills/demo-clean-code", `sidebar(${scheme}): View details opens that item's page`);
      expect((await page.evaluate<string>(`document.querySelector("h1")?.textContent ?? ""`)) === "demo-clean-code", `sidebar(${scheme}): the details page is titled with the item`);
      const detailViolations = await axe(page);
      expect(detailViolations.length === 0, `sidebar(${scheme}): axe on the details page: ${detailViolations.join(", ")}`);
      await page.evaluate(`history.back()`);
      await page.wait(400);
      expect((await page.evaluate<string>(`location.hash`)) === "#/skills", `sidebar(${scheme}): the browser Back button returns to the list`);
      // The office controls take you to the office first.
      await page.evaluate(`[...document.querySelectorAll(".app-actions button")].find((x) => x.textContent.includes("Research"))?.click()`);
      await page.wait(600);
      expect((await page.evaluate<string>(`location.hash`)) === "#/" && (await page.evaluate<boolean>(`Boolean(document.querySelector(".board"))`)), `sidebar(${scheme}): Research from another page opens it in the office`);
      await page.evaluate(`location.hash = "#/skills"`);
      await page.wait(400);
      // The MCP page, and the way back to the office.
      await page.evaluate(`location.hash = "#/mcp"`);
      await page.wait(400);
      const servers = await page.evaluate<string>(`[...document.querySelectorAll(".catalog-grid .card")].map((c) => c.textContent).join(" | ")`);
      expect(servers.includes("demo-files") && servers.includes("Headers set") && !servers.includes("SECRET"), `sidebar(${scheme}): the MCP page shows servers without secrets (${servers})`);
      // Adding a server shows the exact command first; nothing runs until Confirm.
      await page.evaluate(`document.querySelector(".skill-manager details summary")?.click()`);
      await page.wait(200);
      await page.evaluate(`((sel, value) => { const i = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, value); i.dispatchEvent(new Event("input", { bubbles: true })); })('.skill-manager input[placeholder="my-server"]', 'demo-new')`);
      await page.evaluate(`(${setter})('.skill-manager input[placeholder="npx"]', 'npx')`);
      await page.wait(100);
      await page.evaluate(`[...document.querySelectorAll(".skill-manager button")].find((b) => b.textContent.includes("Review the command"))?.click()`);
      await page.wait(300);
      const preview = await page.evaluate<string>(`document.querySelector(".confirm-box")?.textContent ?? ""`);
      expect(preview.includes("claude mcp add") && preview.includes("demo-new") && preview.includes("never starts it"), `sidebar(${scheme}): the command is shown before anything runs (${preview})`);
      expect(await page.evaluate<boolean>(`document.activeElement?.closest(".confirm-box") !== null`), `sidebar(${scheme}): focus moves into the MCP confirm box`);
      await page.evaluate(source);
      const mcpViolations = await axe(page);
      expect(mcpViolations.length === 0, `sidebar(${scheme}): axe on the MCP page with the form and confirm box open: ${mcpViolations.join(", ")}`);
      await page.evaluate(`[...document.querySelectorAll(".confirm-box button")].find((b) => b.textContent === "Cancel")?.click()`);
      await page.wait(300);
      expect(await page.evaluate<string>(`document.activeElement?.textContent ?? ""`) === "Review the command", `sidebar(${scheme}): Cancel returns focus to Review`);
      await page.evaluate(`document.querySelector("[aria-label='Remove demo-docs']")?.click()`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector(".confirm-box")?.textContent ?? ""`)).includes("Remove the MCP server"), `sidebar(${scheme}): removing a server asks first`);
      await page.evaluate(`[...document.querySelectorAll(".confirm-box button")].find((b) => b.textContent === "Cancel")?.click()`);
      await page.wait(200);
      await page.evaluate(`location.hash = "#/"`);
      await page.wait(800);
      expect(await page.evaluate<boolean>(`Boolean(document.querySelector(".app-main"))`), `sidebar(${scheme}): the office is back at #/`);
      console.log(`sidebar(${scheme}): cards=${cards} axe=${listViolations.length}`);
      await close();
    }
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
        await page.evaluate(`document.querySelector("details.start") && (document.querySelector("details.start").open = true)`);
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
        `[...document.querySelectorAll("button, summary, [role=tab], input, textarea")].filter(e => e.offsetParent !== null).map(e => { const b = (e.closest("label") || e).getBoundingClientRect(); return { n: (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 30), w: Math.round(b.width), h: Math.round(b.height) }; }).filter(x => x.h < 44 || x.w < 44).map(x => x.n + " " + x.w + "x" + x.h)`,
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
