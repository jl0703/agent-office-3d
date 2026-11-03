import { fileURLToPath } from "node:url";
import { startServer } from "./app.ts";

function portFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${name} must be a port number from 1 to 65535`);
    process.exit(1);
  }
  return port;
}

const publicPort = portFromEnv("OFFICE_PUBLIC_PORT");
const app = await startServer({
  port: portFromEnv("OFFICE_PORT") ?? 4777,
  publicPort,
  staticDir: fileURLToPath(new URL("../../client/dist", import.meta.url)),
});

// The only place the token is printed. It works once.
console.log(
  `Open this one-time URL in your browser:\nhttp://127.0.0.1:${publicPort ?? app.port}/api/session?t=${app.token}`,
);

process.once("SIGINT", () => void app.close().then(() => process.exit(0)));
