import http from "node:http";
import type { ServerEvent } from "../../shared/events.ts";
import type { RunningServer } from "../src/app.ts";

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

export function send(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Exchanges the one-time token for the session cookie, like the browser does. */
export async function loginTo(s: RunningServer): Promise<{ host: string; cookie: string }> {
  const host = `127.0.0.1:${s.port}`;
  const r = await send(s.port, `/api/session?t=${s.token}`, { headers: { host } });
  return { host, cookie: String(r.headers["set-cookie"]?.[0]).split(";")[0] ?? "" };
}

export type Stream = {
  events: { name: string; data: string }[];
  /** Resolves with the first event (from the start) that matches, or fails after `ms`. */
  next(match: (e: { name: string; data: string }) => boolean, ms?: number): Promise<{ name: string; data: string }>;
  close(): void;
};

/** Opens /events and collects the server-sent events it receives. */
export function openStream(port: number, headers: Record<string, string>): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: Stream["events"] = [];
    let buffer = "";
    const req = http.request({ host: "127.0.0.1", port, path: "/events", headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
          events.push({ name, data });
        }
      });
      resolve({
        events,
        async next(match, ms = 3000) {
          const end = Date.now() + ms;
          while (Date.now() < end) {
            const hit = events.find(match);
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error(`no matching event within ${ms} ms; got: ${events.map((e) => e.name).join(", ")}`);
        },
        close: () => req.destroy(),
      });
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

export const parse = (e: { data: string }) => JSON.parse(e.data) as ServerEvent;

/** A plan that passes submit_plan. */
export const validPlan = { goal: "Fix the bug", steps: ["read the code", "change it"], files: ["src/a.ts"], workers: 1, costUsd: 0.5, risks: "none", undo: "git checkout" };
