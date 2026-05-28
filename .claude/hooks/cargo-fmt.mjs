#!/usr/bin/env node
// (C) PostToolUse hook: format only the Rust file Claude just edited.
//
// Scoped to the single edited *.rs file (not the whole crate) on purpose — the
// existing tree isn't fully rustfmt-clean, so formatting the crate would dump
// unrelated churn into every diff. rustfmt's output always compiles, so this is
// best-effort and never blocks: any failure exits 0 silently.

import { execFileSync } from "node:child_process";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0); // no/garbled payload — nothing to do
}

const file = data?.tool_input?.file_path;
if (!file || !file.endsWith(".rs")) process.exit(0);

try {
  // --edition 2021 matches src-tauri/Cargo.toml so output equals `cargo fmt`.
  execFileSync("rustfmt", ["--edition", "2021", file], { stdio: "ignore" });
} catch {
  // rustfmt missing or file unparseable mid-edit — don't disrupt the session.
}

process.exit(0);
