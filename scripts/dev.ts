import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// The browser uses the Vite port; Vite proxies /api and /events to the server.
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
// One secret per dev run, for the server only: the link and login then survive its auto-restarts.
const sessionSecret = randomBytes(32).toString("hex");
const children = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "--watch", "server/src/main.ts"], {
    stdio: "inherit",
    env: { ...process.env, OFFICE_PUBLIC_PORT: "5173", OFFICE_SESSION_SECRET: sessionSecret },
  }),
  spawn(process.execPath, [vite], { stdio: "inherit" }),
];

for (const child of children) {
  child.once("exit", (code) => {
    for (const other of children) other.kill();
    process.exit(code ?? 0);
  });
}
process.once("SIGINT", () => children.forEach((child) => child.kill()));
