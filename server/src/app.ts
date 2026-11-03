import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { ServerEvent } from "../../shared/events.ts";
import type { Registry } from "./registry.ts";

export type RunningServer = {
  server: http.Server;
  port: number;
  /** One-time secret that the startup URL carries. Print it once, never log it. */
  token: string;
  close(): Promise<void>;
};

type Options = {
  port?: number;
  /** Extra port the browser may use, such as the Vite dev server. */
  publicPort?: number;
  staticDir: string;
  heartbeatMs?: number;
  /** When given, /events starts with a snapshot of its agents and then streams changes. */
  registry?: Registry;
  log?: (line: Record<string, unknown>) => void;
};

const SESSION_COOKIE = "office_session";
const AGENT_COMMAND = /^\/api\/agents\/([A-Za-z0-9_-]{1,100})\/(?:tasks|stop|resume)$/;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

export async function startServer(opts: Options): Promise<RunningServer> {
  const { staticDir, heartbeatMs = 5000 } = opts;
  const root = resolve(staticDir);
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const token = randomBytes(32).toString("hex");
  let tokenUsed = false;
  const sessions = new Set<string>();
  const streams = new Set<http.ServerResponse>();
  const allowedHosts = new Set<string>();

  const deny = (res: http.ServerResponse, status: number, reason: string, req: http.IncomingMessage) => {
    // Log the path only. The query string can hold the token.
    log({ event: "denied", status, reason, method: req.method, path: pathOf(req) });
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(status === 403 ? "Forbidden" : "Error");
  };

  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const host = req.headers.host?.toLowerCase();
    if (!host || !allowedHosts.has(host)) return deny(res, 403, "host", req);

    // The request target is untrusted. `new URL` throws on inputs like "//" or "/\", and a
    // throw in this handler would take the whole server down. It also reads "/\x" and "//x"
    // as a host, so anything that parses to a different host than the placeholder is refused.
    const target = req.url ?? "";
    let url: URL;
    try {
      url = new URL(target, "http://placeholder");
    } catch {
      return deny(res, 400, "bad-url", req);
    }
    if (!target.startsWith("/") || url.host !== "placeholder") return deny(res, 400, "bad-url", req);

    const method = req.method ?? "GET";
    const safeMethod = method === "GET" || method === "HEAD";
    if (!safeMethod) {
      const origin = req.headers.origin;
      if (!origin?.startsWith("http://") || !allowedHosts.has(origin.slice("http://".length).toLowerCase())) {
        return deny(res, 403, "origin", req);
      }
    }

    if (url.pathname === "/api/session") {
      if (method !== "GET") return deny(res, 405, "method", req);
      const given = url.searchParams.get("t") ?? "";
      if (tokenUsed || !sameSecret(given, token)) return deny(res, 403, "token", req);
      tokenUsed = true;
      const session = randomBytes(32).toString("hex");
      sessions.add(session);
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    if (url.pathname === "/events" || url.pathname.startsWith("/api/")) {
      if (!sessions.has(cookieValue(req.headers.cookie, SESSION_COOKIE))) {
        return deny(res, 403, "no-session", req);
      }
      if (url.pathname === "/events" && method === "GET") return openStream(res);
      const command = AGENT_COMMAND.exec(url.pathname);
      if (command?.[1] && method === "POST") {
        // Agents seen through their logs are view-only; nothing is controllable yet.
        const known = opts.registry?.get(command[1]) !== undefined;
        return known ? json(res, 409, { reason: "observed" }) : json(res, 404, { error: "not_found" });
      }
      return deny(res, 404, "not-found", req);
    }

    if (!safeMethod) return deny(res, 405, "method", req);
    serveStatic(req, res, url.pathname).catch(() => {
      log({ event: "static-error", path: pathOf(req) });
      if (res.headersSent) res.destroy();
      else deny(res, 500, "internal", req);
    });
  });

  function openStream(res: http.ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const registry = opts.registry;
    // The snapshot goes first and the subscription follows in the same tick, so no change is missed.
    if (registry) writeEvent(res, { type: "snapshot", agents: registry.snapshot() });
    const unsubscribe = registry?.subscribe((event) => writeEvent(res, event));
    const beat = () => res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    beat();
    const timer = setInterval(beat, heartbeatMs);
    streams.add(res);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe?.();
      streams.delete(res);
    });
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return deny(res, 400, "bad-path", req);
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return deny(res, 400, "bad-path", req);

    const file = resolve(root, "." + (decoded === "/" ? "/index.html" : decoded));
    if (file !== root && !file.startsWith(root + sep)) return deny(res, 403, "traversal", req);

    try {
      if (!(await stat(file)).isFile()) return deny(res, 404, "not-found", req);
    } catch {
      return deny(res, 404, "not-found", req);
    }
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Security-Policy": CSP });
    if (req.method === "HEAD") return res.end();
    // pipeline handles a read error (for example a rebuild mid-request) instead of crashing.
    pipeline(createReadStream(file), res, (err) => {
      if (err) log({ event: "static-error", path: pathOf(req) });
    });
  }

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4777, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  const port = address.port;
  for (const p of [port, opts.publicPort]) {
    if (p === undefined) continue;
    allowedHosts.add(`127.0.0.1:${p}`);
    allowedHosts.add(`localhost:${p}`);
  }

  return {
    server,
    port,
    token,
    close: () =>
      new Promise<void>((done) => {
        for (const s of streams) s.end();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function writeEvent(res: http.ServerResponse, event: ServerEvent) {
  if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function pathOf(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0] ?? "";
}

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
