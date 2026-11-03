import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/app.ts";
import { loginTo, send } from "./helpers.ts";

/** Opens an SSE stream and resolves with the head and the first chunk, then hangs up. */
function firstChunk(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; type: string; chunk: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/events", headers }, (res) => {
      res.setEncoding("utf8");
      res.once("data", (chunk: string) => {
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"]),
          chunk,
        });
        req.destroy();
      });
      if ((res.statusCode ?? 0) >= 400) res.once("end", () => resolve({ status: res.statusCode ?? 0, type: "", chunk: "" }));
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

describe("request guard", () => {
  let srv: RunningServer;
  let staticDir: string;

  before(async () => {
    const root = mkdtempSync(join(tmpdir(), "office-"));
    staticDir = join(root, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<p>PAGE</p>");
    writeFileSync(join(root, "secret.txt"), "SECRET");
    srv = await startServer({ port: 0, staticDir, heartbeatMs: 20 });
  });
  after(async () => {
    await srv.close();
    await Promise.all(extra.map((e) => e.close()));
  });

  const hostOk = () => `127.0.0.1:${srv.port}`;

  const extra: RunningServer[] = [];
  async function fresh(opts: { heartbeatMs?: number; log?: (l: unknown) => void } = {}) {
    const s = await startServer({ port: 0, staticDir, ...opts });
    extra.push(s);
    return s;
  }
  it("listens on 127.0.0.1 only", () => {
    const addr = srv.server.address();
    assert.ok(addr && typeof addr === "object");
    assert.equal(addr.address, "127.0.0.1");
  });

  it("refuses a foreign Host even with the real token or a valid cookie", async () => {
    const s = await fresh();
    const evil = `evil.example:${s.port}`;
    // Right token, wrong Host: refused, and the token must still be unused afterwards.
    const stolen = await send(s.port, `/api/session?t=${s.token}`, { headers: { host: evil } });
    assert.equal(stolen.status, 403);
    assert.equal(stolen.headers["set-cookie"], undefined);
    const { host, cookie } = await loginTo(s);
    assert.ok(cookie.startsWith("office_session="), "the token should still work on the real Host");
    // Valid cookie, wrong Host: refused on the page and on the stream.
    for (const path of ["/", "/events"]) {
      const r = await send(s.port, path, { headers: { host: evil, cookie } });
      assert.equal(r.status, 403, path);
    }
    const ok = await send(s.port, "/", { headers: { host, cookie } });
    assert.equal(ok.status, 200);
  });

  // http.request fills in a default Host, so odd requests go over a raw socket.
  function rawRequest(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => sock.write(text));
      let data = "";
      sock.on("data", (c) => (data += c));
      sock.on("close", () => resolve(data));
      sock.on("error", reject);
    });
  }

  for (const [name, raw] of [
    ["an empty Host", "GET / HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n"],
    ["no Host", "GET / HTTP/1.0\r\n\r\n"],
  ] as const) {
    it(`rejects ${name}`, async () => {
      assert.match(await rawRequest(srv.port, raw), /^HTTP\/1\.[01] 403/);
    });
  }

  for (const target of ["//", "///", "//[", "//x/y", "http://127.0.0.1/", "/\\", "/\\\\", "/\\[", "/\\x", "/\t/["]) {
    it(`answers a malformed request target ${target} with 400 and keeps serving`, async () => {
      const raw = `GET ${target} HTTP/1.1\r\nHost: ${hostOk()}\r\nConnection: close\r\n\r\n`;
      assert.match(await rawRequest(srv.port, raw), /^HTTP\/1\.1 400/);
      const next = await send(srv.port, "/", { headers: { host: hostOk() } });
      assert.equal(next.status, 200);
    });
  }

  it("rejects a POST with a foreign or missing Origin even with a valid cookie", async () => {
    const s = await fresh();
    const { host, cookie } = await loginTo(s);
    const foreign = await send(s.port, "/api/anything", {
      method: "POST",
      headers: { host, cookie, origin: "http://evil.example" },
    });
    assert.equal(foreign.status, 403);
    const otherPort = await send(s.port, "/api/anything", {
      method: "POST",
      headers: { host, cookie, origin: "http://127.0.0.1:1" },
    });
    assert.equal(otherPort.status, 403);
    const missing = await send(s.port, "/api/anything", {
      method: "POST",
      headers: { host, cookie },
    });
    assert.equal(missing.status, 403);
  });

  it("rejects a POST with a good Origin but no session cookie", async () => {
    const r = await send(srv.port, "/api/anything", {
      method: "POST",
      headers: { host: hostOk(), origin: `http://${hostOk()}` },
    });
    assert.equal(r.status, 403);
  });

  it("returns 404 for an unknown route when the Host, Origin, and cookie are good", async () => {
    const s = await fresh();
    const { host, cookie } = await loginTo(s);
    const r = await send(s.port, "/api/anything", {
      method: "POST",
      headers: { host, origin: `http://${host}`, cookie },
    });
    assert.equal(r.status, 404);
  });

  it("denies /events without a cookie and leaks no event data", async () => {
    const r = await send(srv.port, "/events", { headers: { host: hostOk() } });
    assert.equal(r.status, 403);
    assert.ok(!r.body.includes("heartbeat"));
  });

  it("swaps the token for an HttpOnly SameSite=Strict cookie, once", async () => {
    const s = await fresh();
    const host = `127.0.0.1:${s.port}`;
    const first = await send(s.port, `/api/session?t=${s.token}`, { headers: { host } });
    assert.equal(first.status, 302);
    assert.equal(first.headers["location"], "/");
    const cookie = String(first.headers["set-cookie"]?.[0]);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);
    const again = await send(s.port, `/api/session?t=${s.token}`, { headers: { host } });
    assert.equal(again.status, 403);
  });

  it("rejects a wrong token", async () => {
    const r = await send(srv.port, "/api/session?t=nope", { headers: { host: hostOk() } });
    assert.equal(r.status, 403);
    assert.equal(r.headers["set-cookie"], undefined);
  });

  it("streams a heartbeat with a valid cookie", async () => {
    const s = await fresh({ heartbeatMs: 20 });
    const { host, cookie } = await loginTo(s);
    const r = await firstChunk(s.port, { host, cookie });
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/event-stream/);
    assert.match(r.chunk, /event: heartbeat/);
  });

  it("serves the page with a good Host and no cookie", async () => {
    const r = await send(srv.port, "/", { headers: { host: hostOk() } });
    assert.equal(r.status, 200);
    assert.equal(r.body, "<p>PAGE</p>");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
    assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
  });

  for (const path of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%5csecret.txt",
    "/%2e%2e%5csecret.txt",
    "/..\\secret.txt",
    "/%00",
  ]) {
    it(`refuses path traversal: ${path}`, async () => {
      const r = await send(srv.port, path, { headers: { host: hostOk() } });
      assert.notEqual(r.status, 200);
      assert.ok(!r.body.includes("SECRET"));
    });
  }

  it("never logs the token or the session id", async () => {
    const lines: unknown[] = [];
    const s = await fresh({ heartbeatMs: 20, log: (l) => lines.push(l) });
    const { host, cookie } = await loginTo(s);
    const denied = await send(s.port, "/events", { headers: { host: `evil.example:${s.port}`, cookie } });
    assert.equal(denied.status, 403);
    await firstChunk(s.port, { host, cookie });
    const text = JSON.stringify(lines);
    assert.ok(lines.length > 0, "expected some log lines");
    assert.ok(!text.includes(s.token));
    assert.ok(!text.includes(cookie.split("=")[1] ?? "unreachable"));
  });
});
