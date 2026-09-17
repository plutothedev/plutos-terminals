// (C) Flat ESLint config — added 2026-08-21 during the full audit.
//
// Why this exists: the repo shipped ~30k lines of JSX with NO static analysis of
// any kind. The bug classes this codebase keeps hitting (stale closures, missing
// hook deps, hook-order changes, lost-update `save()` spreads) are exactly what
// react-hooks catches mechanically, and it had never been run.
//
// Posture is AUDIT-first, not style-police:
//   - correctness + hooks + a11y are ON,
//   - pure formatting/stylistic rules are OFF (prettier is not in this repo and
//     reformatting 191 files during an audit would bury the real signal).
// `react/prop-types` is off: this is a JS codebase with no propTypes convention.

import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "releases/**",
      "design-mockups/**",
      "design/**",
      "docs/**",
      "public/**",
      "data/**",
      // Claude Code hook scripts — node ESM, not app code, not shipped.
      ".claude/**",
    ],
  },

  js.configs.recommended,

  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    settings: { react: { version: "18.3" } },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // The two that matter most here. Errors, not warnings.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // No propTypes convention in this codebase; would be pure noise.
      "react/prop-types": "off",
      "react/display-name": "off",

      // Correctness rules worth surfacing on an audit pass.
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn",
      "no-unmodified-loop-condition": "error",
      "require-atomic-updates": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },

  // Test files: vitest globals are imported explicitly, but node globals appear.
  {
    files: ["src/**/*.test.{js,jsx}", "**/*.config.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-unused-vars": "off" },
  },

  // Repo scripts run under Node (scripts/smoke-packaged.mjs drives the packaged
  // app over CDP), so they get the node globals; unused-vars stays on.
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
];
