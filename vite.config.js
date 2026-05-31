import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      // Backend transport seam — Tauri IPC on desktop, WebSocket on the phone/web
      // companion. All invoke()/listen() route through here. See src/backend.js.
      "@backend": fileURLToPath(new URL("./src/backend.js", import.meta.url)),
    },
  },
  server: {
    port: 5310,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 5311 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
