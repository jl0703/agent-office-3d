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
      expect(signs >= 4, `rooms(${scheme}): room signs shown (${signs})`);
      const names = await page.evaluate<string>(`[...document.querySelectorAll(".room-sign:not(.hub-sign) .room-name")].map((n) => n.textContent).join(",")`);
      expect(["Management", "Engineering", "Quality", "Visitors"].every((n) => names.split(",").includes(n)), `rooms(${scheme}): the building has a room for each department of the demo team, and Visitors (${names})`);
      await page.screenshot(join(out, `rooms-${scheme}-overview.png`));
      await page.evaluate(`[...document.querySelectorAll(".room-sign:not(.hub-sign)")].find((s) => !s.textContent.includes("0 agents"))?.click()`); // a room with someone in it: an empty one would filter the list to nothing
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
      // An agent that works as a person: the name tag shows the role, and on selection who they report to and the task; the list and panel say the same in text.
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector('[data-agent-id="demo-1"]'))`);
      await page.wait(500);
      const card = await page.evaluate<string>(`(() => { const t = document.querySelector('.office-tag[data-state="selected"]'); const d = t?.querySelector(".tag-detail"); return JSON.stringify({ role: t?.querySelector(".tag-role")?.textContent, detail: d?.textContent, shown: d ? getComputedStyle(d).display !== "none" : false, panel: [...document.querySelectorAll(".panel-facts")].map((f) => f.textContent).join(" "), row: document.querySelector('[data-agent-id="demo-1"]')?.closest("li")?.textContent ?? "" }); })()`);
      expect(card.includes('"role":"Frontend Developer"') && card.includes("Reports to Sam, then Alex") && card.includes("Task:") && card.includes('"shown":true'), `rooms(${scheme}): the selected name tag shows the role, the reporting line and the task (${card.slice(0, 240)})`);
      expect(card.includes("RoleFrontend Developer") && card.includes("Reports toSam, then Alex") && card.includes("Frontend Developer"), `rooms(${scheme}): the panel and the list say the role in text (${card.slice(0, 420)})`);
      await page.screenshot(join(out, `card-${scheme}.png`));
      await page.key("Escape", { keyCode: 27 });
      await page.wait(400);
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
      // The skill eval of a ready build: verdict, details, and a cost question before running again.
      const evalText = await page.evaluate<string>(`document.querySelector("[aria-label='Skill eval']")?.textContent ?? ""`);
      expect(evalText.includes("Improves") && evalText.includes("100%") && evalText.includes("50%"), `workshop(${scheme}): the build shows the eval verdict and both pass rates (${evalText.slice(0, 140)})`);
      await page.evaluate(`[...document.querySelectorAll("[aria-label='Skill eval'] button")].find((b) => b.textContent === "Show the details")?.click()`);
      await page.wait(300);
      expect((await page.evaluate<number>(`document.querySelectorAll(".eval-details .case-box").length`)) === 2, `workshop(${scheme}): the details list both test requests`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))([...document.querySelectorAll("[aria-label='Skill eval'] button")].find((b) => b.textContent === "Run again"))`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("10 to 30 cents for three test requests"), `workshop(${scheme}): running an eval asks first and names the cost`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))([...document.querySelectorAll("[aria-label='Skill eval'] button")].find((b) => b.textContent === "Revise with this feedback"))`);
      await page.wait(300);
      const reviseText = await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`);
      expect(reviseText.includes("Three rounds at most"), `workshop(${scheme}): Revise asks first and says the plan waits for approval (${reviseText.slice(0, 100)} | buttons: ${await page.evaluate<string>(`[...document.querySelectorAll("[aria-label='Skill eval'] button")].map((b) => b.textContent).join(",")`)})`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
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
      const links = await page.evaluate<string>(`[...document.querySelectorAll(".rail a")].map((a) => a.textContent.trim() + "=" + a.getAttribute("href")).join(" | ")`);
      expect(links === "Office=#/ | Skills=#/skills | MCP=#/mcp | Agents=#/agents | Tasks=#/tasks | Team=#/team | Settings=#/settings", `sidebar(${scheme}): the rail has links to every page, Settings last (${links})`);
      const railBox = await page.evaluate<string>(`(() => { const r = document.querySelector(".rail").getBoundingClientRect(); return r.left === 0 && r.width < 100 && r.height > 600 ? "side" : r.bottom >= innerHeight - 1 && r.width > 300 ? "bottom" : "odd"; })()`);
      expect(railBox === (w > 600 ? "side" : "bottom"), `sidebar(${scheme}): the rail is a side bar, a bottom bar on a phone (${railBox})`);
      await page.evaluate(`[...document.querySelectorAll(".rail a")].find((a) => a.textContent.includes("Skills"))?.click()`);
      await page.wait(500);
      const hash = await page.evaluate<string>(`location.hash`);
      expect(hash === "#/skills", `sidebar(${scheme}): choosing Skills goes to its own page (${hash})`);
      const head = await page.evaluate<string>(`document.querySelector("h1")?.textContent ?? ""`);
      expect(head === "Skills", `sidebar(${scheme}): the page title is Skills (${head})`);
      expect(await page.evaluate<string>(`document.activeElement?.id ?? ""`) === "catalog-title", `sidebar(${scheme}): focus moves to the page title`);
      expect((await page.evaluate<string>(`document.title`)).includes("Skills"), `sidebar(${scheme}): the tab title names the page`);
      const cards = await page.evaluate<number>(`document.querySelectorAll(".catalog-grid")[0].querySelectorAll(".card").length`);
      expect(cards === 3, `sidebar(${scheme}): three demo skill cards (${cards})`);
      const crumbs = await page.evaluate<string>(`document.querySelector(".breadcrumb")?.textContent ?? ""`);
      expect(crumbs.includes("Office") && crumbs.includes("Skills"), `sidebar(${scheme}): breadcrumb shows where you are (${crumbs})`);
      // The research finds for this page are listed under their own heading, with stars, language and the source link.
      const foundText = await page.evaluate<string>(`[...document.querySelectorAll(".catalog-section")].map((h) => h.textContent).join(" | ") + " || " + (document.querySelectorAll(".catalog-grid")[1]?.textContent ?? "")`);
      expect(foundText.includes("Found by research (1)") && foundText.includes("880") && foundText.includes("Shell") && foundText.includes("Looking"), `sidebar(${scheme}): the finds section shows stars, language and the decision (${foundText})`);
      expect(await page.evaluate<boolean>(`Boolean(document.querySelector(".catalog-grid:last-of-type a[target=_blank][rel*=noopener]"))`), `sidebar(${scheme}): a find links to its source in a new tab`);
      // The add button sits at the right of the Yours heading, on the same line, and opens a pop-up.
      const row = await page.evaluate<string>(`(() => { const h = document.querySelector(".section-row .catalog-section").getBoundingClientRect(); const b = document.querySelector(".section-row .add-btn").getBoundingClientRect(); return JSON.stringify({ sameLine: Math.abs(h.top - b.top) < 40, right: b.left > h.right }); })()`);
      expect(row === '{"sameLine":true,"right":true}', `sidebar(${scheme}): the Add a skill button is on the Yours line, to the right (${row})`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector(".add-btn"))`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("Skill name"), `sidebar(${scheme}): Add a skill opens a pop-up with the form`);
      expect(await page.evaluate<boolean>(`document.activeElement?.closest("dialog") !== null`), `sidebar(${scheme}): focus is inside the pop-up`);
      await page.screenshot(join(out, `modal-${scheme}.png`));
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      expect(await page.evaluate<boolean>(`!document.querySelector("dialog[open]")`) && (await page.evaluate<string>(`document.activeElement?.textContent ?? ""`)).includes("Add a skill"), `sidebar(${scheme}): Escape closes the pop-up and focus returns to the button`);
      // Sorting and searching.
      const first = () => page.evaluate<string>(`document.querySelector(".catalog-grid .card h3")?.textContent ?? ""`);
      const byName = await first();
      await page.evaluate(`[...document.querySelectorAll(".catalog-tools .chip-filter")].find((b) => b.textContent === "Recent")?.click()`);
      await page.wait(200);
      const byRecent = await first();
      expect(byName === "demo-clean-code" && byRecent === "demo-docs-writer", `sidebar(${scheme}): Recent puts the newest first (${byName} -> ${byRecent})`);
      await page.evaluate(`(() => { const i = document.querySelector(".catalog-search input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "reviews"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await page.wait(200);
      expect((await page.evaluate<number>(`document.querySelectorAll(".catalog-grid")[0].querySelectorAll(".card").length`)) === 1, `sidebar(${scheme}): search narrows the cards`);
      await page.evaluate(`(() => { const i = document.querySelector(".catalog-search input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await page.wait(200);
      // Remove asks first, and Cancel puts focus back.
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector("[aria-label='Remove demo-docs-writer']"))`);
      await page.wait(200);
      const confirmText = await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`);
      expect(confirmText.includes("Change your Claude setup?") && confirmText.includes("demo-docs-writer"), `sidebar(${scheme}): removing asks first (${confirmText})`);
      expect(await page.evaluate<boolean>(`document.activeElement?.closest("dialog") !== null`), `sidebar(${scheme}): focus moves into the confirm box`);
      await page.evaluate(source);
      const listViolations = await axe(page);
      expect(listViolations.length === 0, `sidebar(${scheme}): axe on the skills page with the confirm box open: ${listViolations.join(", ")}`);
      await page.screenshot(join(out, `catalog-${scheme}.png`));
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Cancel")?.click()`);
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
      // A research find has its own page, with the fit check and the actions.
      await page.evaluate(`document.querySelector("[aria-label='View details for Demo: a pack of documentation skills']")?.click()`);
      await page.wait(400);
      expect((await page.evaluate<string>(`location.hash`)) === "#/finds/demo-skills-pack", `sidebar(${scheme}): a find card opens its own page`);
      await page.wait(200);
      const marked = await page.evaluate<string>(`document.querySelector(".rail a[aria-current=page]")?.textContent ?? ""`);
      expect(marked.trim() === "Skills", `sidebar(${scheme}): a find keeps its list marked in the rail (${marked})`);
      expect((await page.evaluate<string>(`document.title`)).includes("Demo: a pack of documentation skills"), `sidebar(${scheme}): the tab title names the find`);
      const findText = await page.evaluate<string>(`document.querySelector("main")?.textContent ?? ""`);
      expect(findText.includes("Fit check: Fits") && findText.includes("Skills") && findText.includes("Open on GitHub"), `sidebar(${scheme}): the find page shows the fit check, its place in the breadcrumb and the source link (${findText.slice(0, 160)})`);
      expect(await page.evaluate<boolean>(`![...document.querySelectorAll("main button")].some((b) => b.textContent.includes("Build in the Workshop"))`), `sidebar(${scheme}): no Build button until the find is adopted`);
      await page.evaluate(`[...document.querySelectorAll("[aria-label='Your decision'] button")].find((b) => b.textContent === "Adopt")?.click()`);
      await page.wait(300);
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll("main button")].some((b) => b.textContent.includes("Build in the Workshop"))`), `sidebar(${scheme}): adopting offers Build in the Workshop`);
      // The progress strip and the next step; adopting a find with no brief offers to write one.
      const strip = await page.evaluate<string>(`[...document.querySelectorAll(".stepper .step")].map((li) => li.className.replace("step step-", "")).join(",")`);
      expect(strip === "done,done,current,done,done", `sidebar(${scheme}): the strip shows the brief as the step still to do (${strip})`);
      expect((await page.evaluate<string>(`document.querySelector("[aria-label='Skill eval']")?.textContent ?? ""`)).includes("Improves"), `sidebar(${scheme}): the find page shows the skill eval verdict`);
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll("main button")].some((b) => b.textContent.includes("Write the brief"))`), `sidebar(${scheme}): an adopted find without a brief offers Write the brief`);
      // A find that has a brief shows it, and the owner can open the editor.
      await page.evaluate(`location.hash = "#/finds/demo-memory-idea"`);
      await page.wait(500);
      const briefText = await page.evaluate<string>(`document.querySelector("[aria-label='Brief for the implementor']")?.textContent ?? ""`);
      expect(briefText.includes("Test request 1") && briefText.includes("mentions the earlier result"), `sidebar(${scheme}): the brief and its test requests are shown (${briefText.slice(0, 120)})`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))([...document.querySelectorAll("main button")].find((b) => b.textContent.includes("Edit the brief")))`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("Checks the answer must pass"), `sidebar(${scheme}): Edit the brief opens the editor pop-up`);
      const briefViolations = await axe(page);
      expect(briefViolations.length === 0, `sidebar(${scheme}): axe with the brief editor open: ${briefViolations.join(", ")}`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      await page.evaluate(`history.back()`);
      await page.wait(400);
      await page.wait(700); // the pressed chip fades its colour in; axe must not read it half way
      await page.screenshot(join(out, `find-${scheme}.png`));
      const findViolations = await axe(page);
      expect(findViolations.length === 0, `sidebar(${scheme}): axe on the find page: ${findViolations.join(", ")}`);
      await page.evaluate(`history.back()`);
      await page.wait(400);
      // The Tasks board: four columns, with cards from the demo agents, builds and finds.
      await page.evaluate(`[...document.querySelectorAll(".rail a")].find((a) => a.textContent.includes("Tasks"))?.click()`);
      await page.wait(500);
      const board = await page.evaluate<string>(`JSON.stringify({ hash: location.hash, title: document.title, cols: [...document.querySelectorAll(".board-col h2")].map((h) => h.firstChild.textContent.trim()), cards: document.querySelectorAll(".task-card").length, marked: document.querySelector(".rail a[aria-current=page]")?.textContent.trim() })`);
      const parsed = JSON.parse(board) as { hash: string; title: string; cols: string[]; cards: number; marked: string };
      expect(parsed.hash === "#/tasks" && parsed.title === "Tasks - Agent Office" && parsed.marked === "Tasks" && parsed.cols.join(",") === "Active,In progress,Review,Done" && parsed.cards > 3, `sidebar(${scheme}): the Tasks board has four columns and cards (${board})`);
      await page.wait(700);
      await page.screenshot(join(out, `tasks-${scheme}.png`));
      const taskViolations = await axe(page);
      expect(taskViolations.length === 0, `sidebar(${scheme}): axe on Tasks: ${taskViolations.join(", ")}`);
      await page.evaluate(`[...document.querySelectorAll(".task-card a.link-btn")].find((a) => a.href.includes("#/finds/"))?.click()`);
      await page.wait(400);
      expect((await page.evaluate<string>(`location.hash`)).startsWith("#/finds/"), `sidebar(${scheme}): a task card opens its find`);
      await page.evaluate(`location.hash = "#/tasks"`);
      await page.wait(400);
      // The owner's tasks: an assignee picker on each, Start needs a person, and New task and Start open pop-ups.
      const own = await page.evaluate<string>(`JSON.stringify({ selects: document.querySelectorAll(".task-card select").length, startOff: [...document.querySelectorAll(".task-card")].find((c) => c.textContent.includes("Plan next month"))?.querySelector("button")?.disabled, riley: [...document.querySelectorAll(".task-card")].find((c) => c.textContent.includes("Make the header sticky"))?.querySelector("select option:checked")?.textContent })`);
      expect(own.includes('"selects":5') && own.includes('"startOff":true') && own.includes("Riley, Frontend Developer"), `sidebar(${scheme}): the owner's tasks show who they are given to, and Start waits for a person (${own})`);
      // Every card says who it is for; a suggestion from an agent can be accepted or dismissed but not started; the + under Active adds a task.
      const assignees = await page.evaluate<string>(`JSON.stringify({ cards: document.querySelectorAll(".task-card").length, withAssignee: [...document.querySelectorAll(".task-card")].filter((c) => c.querySelector(".task-assignee")).length, avatars: document.querySelectorAll(".task-assignee svg.avatar").length, sug: (() => { const c = [...document.querySelectorAll(".task-card")].find((x) => x.textContent.includes("Suggested by Planner")); return { buttons: [...(c?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()), column: c?.closest(".board-col")?.querySelector("h2")?.textContent }; })() })`);
      const asg = JSON.parse(assignees) as { cards: number; withAssignee: number; avatars: number; sug: { buttons: string[]; column: string } };
      expect(asg.cards === asg.withAssignee && asg.avatars >= 3 && asg.sug.column?.startsWith("Active") && asg.sug.buttons.join(",") === "Accept Add a changelog,Dismiss Add a changelog", `sidebar(${scheme}): every card shows its assignee, and a suggestion offers Accept and Dismiss (${assignees.slice(0, 260)})`);
      const plus = await page.evaluate<string>(`JSON.stringify((() => { const col = document.querySelector(".board-col"); const b = col?.querySelector("button.add-round"); const last = [...(col?.querySelectorAll(".task-card") ?? [])].at(-1); return { label: b?.getAttribute("aria-label"), under: b && last ? b.getBoundingClientRect().top >= last.getBoundingClientRect().bottom - 1 : false, first: col?.querySelector("h2")?.textContent?.startsWith("Active") }; })())`);
      expect(plus === '{"label":"Add a task","under":true,"first":true}', `sidebar(${scheme}): a small + under the first column's cards (${plus})`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector(".board-col button.add-round"))`);
      await page.wait(600);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("Assigned to"), `sidebar(${scheme}): the + opens the New task pop-up`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      expect(await page.evaluate<boolean>(`!document.querySelector("dialog[open]") && document.activeElement?.classList.contains("add-round")`), `sidebar(${scheme}): Escape returns focus to the + button`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))([...document.querySelectorAll(".add-btn")].find((b) => b.textContent.includes("New task")))`);
      await page.wait(600);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("Assigned to"), `sidebar(${scheme}): New task opens a pop-up with an assignee`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))([...document.querySelectorAll(".task-card")].find((c) => c.textContent.includes("Make the header sticky"))?.querySelector(".task-foot:last-child button"))`);
      await page.wait(300);
      const startText = await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`);
      expect(startText.includes("Riley, Frontend Developer") && startText.includes("waits for your approval") && startText.includes("Folder"), `sidebar(${scheme}): Start asks for a folder and says the plan waits for approval (${startText.slice(0, 160)})`);
      const startViolations = await axe(page);
      expect(startViolations.length === 0, `sidebar(${scheme}): axe with the Start pop-up open: ${startViolations.join(", ")}`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      // The Team page: people with a role and who they report to, as cards and as an org chart; adding opens a pop-up.
      await page.evaluate(`[...document.querySelectorAll(".rail a")].find((a) => a.textContent.includes("Team"))?.click()`);
      await page.wait(500);
      const teamCards = await page.evaluate<string>(`JSON.stringify({ hash: location.hash, title: document.title, cards: document.querySelectorAll(".person-card").length, line: [...document.querySelectorAll(".person-card")].find((c) => c.textContent.includes("Riley"))?.textContent ?? "" })`);
      expect(teamCards.includes('"hash":"#/team"') && teamCards.includes("Team - Agent Office") && teamCards.includes('"cards":6') && teamCards.includes("Reports to Sam, then Alex") && teamCards.includes("Department: Engineering"), `sidebar(${scheme}): the Team page shows six people, who each reports to and their department (${teamCards.slice(0, 200)})`);
      expect(await page.evaluate<boolean>(`document.querySelectorAll(".person-card svg.avatar").length === 6 && [...document.querySelectorAll(".person-card svg.avatar")].every((s) => s.getAttribute("aria-hidden") === "true")`), `sidebar(${scheme}): each person card has a picture that screen readers skip`);
      await page.screenshot(join(out, `team-cards-${scheme}.png`));
      await page.evaluate(`[...document.querySelectorAll(".chips button")].find((b) => b.textContent === "Org chart")?.click()`);
      await page.wait(300);
      expect(await page.evaluate<boolean>(`document.querySelectorAll(".org-node svg.avatar").length === 6`), `sidebar(${scheme}): each org chart node has a picture`);
      expect(await page.evaluate<boolean>(`document.querySelectorAll(".org-tree .org-node").length === 6 && Boolean(document.querySelector(".org-tree ul ul"))`), `sidebar(${scheme}): the org chart nests the people by who reports to whom`);
      await page.wait(700);
      await page.screenshot(join(out, `team-${scheme}.png`));
      const teamViolations = await axe(page);
      expect(teamViolations.length === 0, `sidebar(${scheme}): axe on Team: ${teamViolations.join(", ")}`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))([...document.querySelectorAll(".add-btn")].find((b) => b.textContent.includes("Add a person")))`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("Reports to") && (await page.evaluate<boolean>(`Boolean(document.querySelector("dialog[open] input[placeholder=Engineering]")) && document.querySelectorAll("dialog[open] datalist option").length === 3`)), `sidebar(${scheme}): Add a person opens a pop-up with the form and a department field that suggests the departments in use`);
      // The designer: a preview and a row of choices per part; Randomize changes the picture and Reset brings it back.
      const designer = await page.evaluate<string>(`JSON.stringify({ rows: document.querySelectorAll("dialog[open] .designer-row").length, swatches: document.querySelectorAll("dialog[open] .swatch").length, resetOff: [...document.querySelectorAll("dialog[open] .designer button")].find((b) => b.textContent === "Reset")?.disabled })`);
      expect(designer === '{"rows":9,"swatches":30,"resetOff":true}', `sidebar(${scheme}): the pop-up has the picture designer (${designer})`);
      const pickPreview = `[...document.querySelectorAll("dialog[open] .designer button[aria-pressed=true]")].map((b) => b.getAttribute("aria-label") ?? b.textContent).join("|")`;
      const before = await page.evaluate<string>(pickPreview);
      let after = before;
      for (let tries = 0; tries < 6 && after === before; tries++) {
        await page.evaluate(`[...document.querySelectorAll("dialog[open] .designer button")].find((b) => b.textContent === "Randomize")?.click()`);
        await page.wait(250);
        after = await page.evaluate<string>(pickPreview);
      }
      expect(after !== before, `sidebar(${scheme}): Randomize changes the picture`);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] .designer button")].find((b) => b.textContent === "Reset")?.click()`);
      await page.wait(300);
      const restored = await page.evaluate<string>(pickPreview);
      expect(restored === before, `sidebar(${scheme}): Reset brings back the look the pop-up opened with (${before} | ${restored})`);
      // Every outfit draws something different (a choice that changes nothing would be a bug).
      const outfits = new Set<string>();
      for (let n = 1; n <= 5; n++) {
        await page.evaluate(`document.querySelector('dialog[open] .designer-row[aria-label="Outfit"] button:nth-child(${n})')?.click()`);
        await page.wait(80);
        outfits.add(await page.evaluate<string>(`document.querySelector("dialog[open] .designer-top svg")?.innerHTML ?? ""`));
      }
      expect(outfits.size === 5, `sidebar(${scheme}): each of the five outfits draws differently (${outfits.size})`);
      await page.evaluate(`document.querySelector('dialog[open] .designer-row[aria-label="Hair style"] button:nth-child(3)')?.click()`);
      await page.wait(100);
      expect(await page.evaluate<boolean>(`document.querySelector('dialog[open] .designer-row[aria-label="Hair style"] button:nth-child(3)')?.getAttribute("aria-pressed") === "true"`), `sidebar(${scheme}): choosing a hair style marks it pressed`);
      await page.wait(700); // the pressed chip fades its colour in; axe must not read it half way
      await page.screenshot(join(out, `designer-${scheme}.png`));
      await page.wait(700); // taking the picture can restart the fade of a pressed chip
      const popViolations = await axe(page);
      expect(popViolations.length === 0, `sidebar(${scheme}): axe with the person pop-up open: ${popViolations.join(", ")}`);
      await page.key("Escape", { keyCode: 27 });
      await page.wait(300);
      expect(await page.evaluate<boolean>(`!document.querySelector("dialog[open]") && document.activeElement?.textContent?.includes("Add a person")`), `sidebar(${scheme}): Escape closes the pop-up and focus returns to the button`);
      // The Settings page, reached from the end of the rail.
      await page.evaluate(`[...document.querySelectorAll(".rail a")].find((a) => a.textContent.includes("Settings"))?.click()`);
      await page.wait(400);
      expect((await page.evaluate<string>(`location.hash + "|" + document.title + "|" + document.querySelector("h1")?.textContent + "|" + document.querySelector(".rail a[aria-current=page]")?.textContent`)) === "#/settings|Settings - Agent Office|Settings|Settings", `sidebar(${scheme}): Settings opens its page and is marked in the rail`);
      const settingsText = await page.evaluate<string>(`document.querySelector("main")?.textContent ?? ""`);
      expect(settingsText.includes("Demo mode") && settingsText.includes("Usage limit") && settingsText.includes("Plans that start without asking"), `sidebar(${scheme}): Settings shows the demo switch, the usage limit and the auto-approve rule`);
      const settingsViolations = await axe(page);
      expect(settingsViolations.length === 0, `sidebar(${scheme}): axe on Settings: ${settingsViolations.join(", ")}`);
      // The MCP page, and the way back to the office.
      await page.evaluate(`location.hash = "#/mcp"`);
      await page.wait(400);
      const servers = await page.evaluate<string>(`[...document.querySelectorAll(".catalog-grid .card")].map((c) => c.textContent).join(" | ")`);
      expect(servers.includes("demo-files") && servers.includes("Headers set") && !servers.includes("SECRET"), `sidebar(${scheme}): the MCP page shows servers without secrets (${servers})`);
      // Adding a server shows the exact command first; nothing runs until Confirm.
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector(".add-btn"))`);
      await page.wait(200);
      await page.evaluate(`((sel, value) => { const i = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, value); i.dispatchEvent(new Event("input", { bubbles: true })); })('dialog[open] input[placeholder="my-server"]', 'demo-new')`);
      await page.evaluate(`(${setter})('dialog[open] input[placeholder="npx"]', 'npx')`);
      await page.wait(100);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.includes("Review the command"))?.click()`);
      await page.wait(300);
      const preview = await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`);
      expect(preview.includes("claude mcp add") && preview.includes("demo-new") && preview.includes("never starts it"), `sidebar(${scheme}): the command is shown before anything runs (${preview})`);
      expect(await page.evaluate<boolean>(`document.activeElement?.closest("dialog") !== null`), `sidebar(${scheme}): focus moves into the MCP confirm box`);
      await page.evaluate(source);
      const mcpViolations = await axe(page);
      expect(mcpViolations.length === 0, `sidebar(${scheme}): axe on the MCP page with the form and confirm box open: ${mcpViolations.join(", ")}`);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Back")?.click()`);
      for (let i = 0; i < 20 && !(await page.evaluate<boolean>(`Boolean(document.querySelector("dialog[open] input[placeholder=my-server]"))`)); i++) await page.wait(100);
      expect(await page.evaluate<boolean>(`Boolean(document.querySelector("dialog[open] input[placeholder=my-server]"))`), `sidebar(${scheme}): Back returns to the form with the pop-up still open`);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Cancel")?.click()`);
      for (let i = 0; i < 20 && !(await page.evaluate<string>(`document.activeElement?.textContent ?? ""`)).includes("Add an MCP server"); i++) await page.wait(100);
      expect((await page.evaluate<string>(`document.activeElement?.textContent ?? ""`)).includes("Add an MCP server"), `sidebar(${scheme}): closing the pop-up returns focus to the button that opened it`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector("[aria-label='Remove demo-docs']"))`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("Remove the MCP server"), `sidebar(${scheme}): removing a server asks first`);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Cancel")?.click()`);
      await page.wait(200);
      // The AI Agents page: cards, add form, remove asks first, details.
      await page.evaluate(`[...document.querySelectorAll(".app-actions button")].length`);
      await page.evaluate(`location.hash = "#/agents"`);
      await page.wait(500);
      const agentCards = await page.evaluate<string>(`[...document.querySelectorAll(".catalog-grid .card")].map((c) => c.querySelector("h3")?.textContent + ":" + c.textContent).join(" | ")`);
      expect(agentCards.includes("demo-reviewer") && agentCards.includes("Model sonnet") && agentCards.includes("demo-planner"), `sidebar(${scheme}): the agents page lists agents with model and tools (${agentCards})`);
      expect((await page.evaluate<string>(`document.querySelector("main")?.textContent ?? ""`)).includes("1 rejected find is hidden"), `sidebar(${scheme}): rejected finds are hidden with a note saying so`);
      expect((await page.evaluate<string>(`document.querySelector(".add-btn")?.textContent ?? ""`)).includes("Add an agent"), `sidebar(${scheme}): the agents page can add an agent`);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector(".add-btn"))`);
      await page.wait(200);
      await page.evaluate(`(${setter})('dialog[open] input[placeholder="my-agent"]', 'demo-new-agent')`);
      await page.evaluate(`(() => { const t = document.querySelector('dialog[open] textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'x'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await page.wait(100);
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Review')?.click()`);
      await page.wait(200);
      expect((await page.evaluate<string>(`document.querySelector('dialog[open]')?.textContent ?? ''`)).includes('every tool'), `sidebar(${scheme}): adding an agent without tools says it can use every tool`);
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Back')?.click()`);
      await page.wait(200);
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel')?.click()`);
      await page.wait(200);
      await page.wait(200);
      await page.evaluate(`((e) => (e?.focus(), e?.click()))(document.querySelector("[aria-label='Remove demo-planner']"))`);
      await page.wait(200);
      expect((await page.evaluate<string>(`document.querySelector("dialog[open]")?.textContent ?? ""`)).includes("agents folder"), `sidebar(${scheme}): removing an agent asks first`);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Cancel")?.click()`);
      await page.evaluate(`document.querySelector("[aria-label='View details for demo-reviewer']")?.click()`);
      await page.wait(300);
      expect((await page.evaluate<string>(`document.querySelector(".item-facts")?.textContent ?? ""`)).includes("sonnet"), `sidebar(${scheme}): an agent's details page shows its model`);
      await page.evaluate(source);
      const agentViolations = await axe(page);
      expect(agentViolations.length === 0, `sidebar(${scheme}): axe on the agent details page: ${agentViolations.join(", ")}`);
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
