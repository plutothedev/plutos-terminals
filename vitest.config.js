import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@backend": fileURLToPath(new URL("./src/backend.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // .jsx tests = the P2-T2 render-containment harness (hook renders need
    // the JSX transform + a DOM; those files opt into happy-dom per-file via
    // an @vitest-environment pragma).
    include: ["src/**/*.test.js", "src/**/*.test.jsx"],
  },
});
