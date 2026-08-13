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
  build: {
    // Webview floor (P4-T2): WebView2 is evergreen chromium but macOS ships
    // WKWebView — esnext output can emit syntax older-macOS Safari engines
    // choke on. Pinned, not esnext.
    target: ["chrome107", "safari16"],
    // Single-webview app, no legacy browsers to preload-polyfill for.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // rolldown-vite's chunking API (vite 8 on rolldown 1.0-rc; the older
        // `advancedChunks` name is deprecated + console-warned). Named vendor
        // chunks so app-code edits don't bust the react/xterm cache lines.
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor-xterm", test: /node_modules[\\/]@xterm[\\/]/ },
          ],
        },
      },
    },
  },
}));
