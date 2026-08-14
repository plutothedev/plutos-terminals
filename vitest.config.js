import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@backend": fileURLToPath(new URL("./src/backend.js", import.meta.url)),
    },
  },
  // App source uses the React 17+ automatic JSX runtime (vite plugin-react);
  // vitest's bare esbuild defaults to the classic transform, which would make
  // every .jsx import demand `import React`. Mirror the app here.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // .jsx tests = the P2-T2 render-containment harness (hook renders need
    // the JSX transform + a DOM; those files opt into happy-dom per-file via
    // an @vitest-environment pragma).
    include: ["src/**/*.test.js", "src/**/*.test.jsx"],
  },
});
