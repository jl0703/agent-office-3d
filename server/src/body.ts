import type http from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const MAX_BODY_BYTES = 64 * 1024;

/** Reads a JSON request body. Requires a JSON content type and stops at the size limit. */
export function readJson(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\s*(;.*)?$/i.test(req.headers["content-type"] ?? "")) {
      return reject(new HttpError(415, "unsupported_media_type"));
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) return reject(new HttpError(413, "too_large"));

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume();
        return reject(new HttpError(413, "too_large"));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    req.on("error", () => reject(new HttpError(400, "invalid_request")));
  });
}
