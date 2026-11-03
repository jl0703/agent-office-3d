import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env["OFFICE_PORT"] ?? "4777";
const target = `http://127.0.0.1:${serverPort}`;

// No changeOrigin: the server checks Host/Origin, so they must reach it unchanged.
export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": target, "/events": target },
  },
});
