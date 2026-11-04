/* eslint-disable @typescript-eslint/no-explicit-any -- protocol messages are untyped JSON */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A small driver for a Chromium browser (Edge or Chrome) over the DevTools protocol.
// Used to look at the real page: screenshots, clicks, key presses, measurements, console output.
// Nothing here ships with the app.

process.setMaxListeners(0); // one exit handler per browser and server
process.once("SIGINT", () => process.exit(130)); // Ctrl+C runs the exit handlers that clean up

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  process.env["BROWSER_PATH"],
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function findBrowser(): string {
  const found = CANDIDATES.find((p): p is string => Boolean(p) && existsSync(p as string));
  if (!found) throw new Error("No Edge or Chrome found. Set BROWSER_PATH to its executable.");
  return found;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export type LaunchOptions = {
  width?: number;
  height?: number;
  /** Draw without a graphics card (SwiftShader), a stand-in for a slow machine. */
  software?: boolean;
  /** Do not hold the frame rate to the screen's refresh rate, to see how much headroom there is. */
  uncapped?: boolean;
  /** Start with WebGL switched off, to see the page's fallback. */
  noWebgl?: boolean;
};

export type Page = {
  goto(url: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(path: string): Promise<void>;
  /** Presses and releases a key. */
  key(key: string, options?: { code?: string; keyCode?: number }): Promise<void>;
  click(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  viewport(width: number, height: number, mobile?: boolean): Promise<void>;
  emulate(media: { scheme?: "light" | "dark"; reducedMotion?: boolean; forcedColors?: boolean }): Promise<void>;
  cpuThrottle(rate: number): Promise<void>;
  /** Everything written to the console, and every failed request, since the page was opened. */
  problems(): string[];
  /** Every address the page asked for since it was opened. */
  requests(): string[];
  wait(ms: number): Promise<void>;
};

export type Browser = { page: Page; close(): Promise<void> };

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "browser-profile-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${opts.width ?? 1440},${opts.height ?? 900}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    "--hide-scrollbars",
  ];
  if (opts.noWebgl) args.push("--disable-3d-apis", "--disable-gpu", "--disable-software-rasterizer");
  if (opts.uncapped) args.push("--disable-frame-rate-limit", "--disable-gpu-vsync");
  if (opts.software) args.push("--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  args.push("about:blank");
  spawn(findBrowser(), args, { stdio: "ignore", windowsHide: true });

  // Edge starts helper processes that outlive the one we launched, so kill everything that was started
  // with this run's profile folder, then delete the folder.
  const stop = () => {
    try {
      if (process.platform === "win32") {
        const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
      } else {
        execSync(`pkill -9 -f ${JSON.stringify(profile)}`, { stdio: "ignore" });
      }
    } catch {
      // already gone
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // a file may still be in use; the system temp folder is cleaned up eventually
    }
  };
  process.once("exit", stop); // also runs when the script is stopped by Ctrl+C or throws

  try {
    let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 100 && targets.length === 0; i++) {
      try {
        targets = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof targets).filter((t) => t.type === "page");
      } catch {
        await sleep(100);
      }
    }
    const target = targets[0];
    if (!target) throw new Error("the browser did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not connect to the browser"));
    });

    let nextId = 1;
    const waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
    const problems: string[] = [];
    const requests: string[] = [];
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, any>; result?: unknown; error?: { message: string } };
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      } else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(m.params?.["type"])) {
        problems.push(`console.${m.params?.["type"]}: ${(m.params?.["args"] ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}`);
      } else if (m.method === "Network.requestWillBeSent") {
        requests.push(String(m.params?.["request"]?.url ?? ""));
      } else if (m.method === "Runtime.exceptionThrown") {
        problems.push(`exception: ${m.params?.["exceptionDetails"]?.exception?.description?.slice(0, 200) ?? m.params?.["exceptionDetails"]?.text}`);
      } else if (m.method === "Log.entryAdded" && ["error", "warning"].includes(m.params?.["entry"]?.level)) {
        problems.push(`log.${m.params?.["entry"]?.level}: ${m.params?.["entry"]?.text} ${m.params?.["entry"]?.url ?? ""}`.slice(0, 220));
      }
    };
    const send = <T = any>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result as T)));
        ws.send(JSON.stringify({ id, method, params }));
      });
    for (const domain of ["Page", "Runtime", "Log", "Network"]) await send(`${domain}.enable`);
    // A headless tab can fall into the "hidden" state after repeated navigations, which pauses drawing.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });

    const modifiers = (key: string) => ({ Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 })[key] ?? 0;

    const page: Page = {
      async goto(url) {
        await send("Page.bringToFront");
        await send("Page.navigate", { url });
        for (let i = 0; i < 150; i++) {
          if ((await page.evaluate<string>("document.readyState")) === "complete") return;
          await sleep(100);
        }
        throw new Error(`page did not finish loading: ${url}`);
      },
      async evaluate<T>(expression: string) {
        const r = await send<{ result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result?.value as T;
      },
      async screenshot(path) {
        const r = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        writeFileSync(path, Buffer.from(r.data, "base64"));
      },
      async key(key, options = {}) {
        const code = options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
        const keyCode = options.keyCode ?? modifiers(key) ?? 0;
        const text = key.length === 1 ? key : key === "Enter" ? String.fromCharCode(13) : undefined;
        await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
      },
      async move(x, y) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      },
      async click(x, y) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      },
      async viewport(width, height, mobile = false) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      },
      async emulate(media) {
        const features = [
          ...(media.scheme ? [{ name: "prefers-color-scheme", value: media.scheme }] : []),
          ...(media.reducedMotion !== undefined ? [{ name: "prefers-reduced-motion", value: media.reducedMotion ? "reduce" : "no-preference" }] : []),
          ...(media.forcedColors !== undefined ? [{ name: "forced-colors", value: media.forcedColors ? "active" : "none" }] : []),
        ];
        await send("Emulation.setEmulatedMedia", { features });
      },
      async cpuThrottle(rate) {
        await send("Emulation.setCPUThrottlingRate", { rate });
      },
      problems: () => [...problems],
      requests: () => [...requests],
      wait: sleep,
    };

    return {
      page,
      async close() {
        ws.close();
        stop();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
