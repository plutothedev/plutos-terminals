#!/usr/bin/env node
// (C) PreToolUse hook: refuse direct edits to dependency lock files.
//
// Cargo.lock / package-lock.json are derived artifacts. Hand-editing them causes
// dependency drift (and this project's vendored-openssl / arm64 link setup is
// fragile). Exit code 2 blocks the tool call and feeds stderr back to Claude.

import { basename } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const file = data?.tool_input?.file_path || "";
const blocked = new Set(["Cargo.lock", "package-lock.json"]);

if (blocked.has(basename(file))) {
  process.stderr.write(
    `Refusing to edit ${basename(file)} directly — it's a generated lock file.\n` +
      `Change dependencies via \`cargo add/update\` or \`npm install\` and let the ` +
      `package manager regenerate the lock file.\n`
  );
  process.exit(2); // 2 = block the tool call (PreToolUse)
}

process.exit(0);
