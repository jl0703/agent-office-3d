import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The browser uses the Vite port; Vite proxies /api and /events to the server.
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const children = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "--watch", "server/src/main.ts"], {
    stdio: "inherit",
    env: { ...process.env, OFFICE_PUBLIC_PORT: "5173" },
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
