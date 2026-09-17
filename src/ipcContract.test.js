// (C)
// The JS<->Rust IPC name contract, checked against the REAL sources.
//
// Audit 2026-08-21, TQ-5 / forward-risk FR2: 88 of 104 commands were named in
// no test on either side, and nothing verified that a JS `invoke("name")`
// resolves to a command the Rust side registers. Rename a command in Rust, or
// lose a `generate_handler!` line in a merge, and both suites stay green while
// the feature 404s at runtime for every user.
//
// This parses `src-tauri/src/**/*.rs` and `src/**/*.{js,jsx}` at run time. It
// deliberately does NOT read `docs/audit-2026-08-21/00-baseline/ipc-manifest.json`:
// asserting against a checked-in snapshot of production truth is the failure
// mode three other tests in this repo already have (TQ-1, TQ-3): the snapshot
// and the code drift apart and the test keeps passing. Same reasoning as
// `reserved_names_match_js_mirror` (commands.rs), which `include_str!`s the JS
// it mirrors rather than restating it.
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTauriCommands,
  parseGenerateHandler,
  parseInvokeCalls,
  stripJsComments,
} from "./ipcContract.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// This file's own fixtures contain deliberately invalid command names, so it
// must not be scanned as a call site. Nothing else is excluded, because a test
// that invokes a command that no longer exists is a real break too.
const SELF = rel(fileURLToPath(import.meta.url));

// ── Corpus ──────────────────────────────────────────────────────────────────

const defined = new Map(); // name -> "file:line"
for (const f of walk(path.join(ROOT, "src-tauri", "src"), [".rs"])) {
  for (const { name, line } of parseTauriCommands(readFileSync(f, "utf8"))) {
    defined.set(name, `${rel(f)}:${line}`);
  }
}

const registered = parseGenerateHandler(
  readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8")
);
const registeredNames = new Set(registered.map((r) => r.name));

const callSites = []; // {name, dynamic, at}
for (const f of walk(path.join(ROOT, "src"), [".js", ".jsx"])) {
  if (rel(f) === SELF) continue;
  for (const c of parseInvokeCalls(readFileSync(f, "utf8"))) {
    callSites.push({ ...c, at: `${rel(f)}:${c.line}` });
  }
}
const namedSites = callSites.filter((c) => !c.dynamic);
const calledNames = new Set(namedSites.map((c) => c.name));

// Registered commands with no `invoke("name")` anywhere in `src/`. Each was
// checked by hand on 2026-08-21 against BOTH the webview call sites and the
// phone companion's RPC allow-list (`dispatch` in companion.rs, 13 commands).
// None of the four is companion-only: all four are genuinely unreachable today.
// They stay registered on purpose, so the exemption is recorded rather than the
// command deleted. But a FIFTH one appearing means a UI path was lost or a
// backend feature was never wired up, and that is worth a look.
const UNCALLED_BY_DESIGN = {
  // Superseded, not replaced 1:1. Per-tab deletion; the renderer now relies on
  // `scrollback_sweep` (age-based GC, and it IS called) to reclaim files, so
  // nothing deletes a single tab's scrollback on demand any more.
  scrollback_delete: "superseded by the scrollback_sweep age GC",
  // The transcript UI reads whole histories via `transcript_read_all` (called).
  // The per-date list/read pair was the earlier date-browser shape and no
  // component calls either one now.
  transcript_list: "date-browser UI shape that was never built; transcript_read_all is what ships",
  transcript_read: "date-browser UI shape that was never built; transcript_read_all is what ships",
  // Cache-invalidation entry point for the MCP connection map. Reachable only
  // from a "reconnect server" control the MCP panel does not render yet.
  mcp_reconnect: "MCP reconnect control not built in the UI yet",
};

// ── Anti-vacuity floors ─────────────────────────────────────────────────────
//
// Every assertion below is of the form "no element of set X violates Y", which
// passes trivially when a parser silently stops matching. The counts at HEAD
// are 104 defined / 104 registered / 164 named call sites across 100 distinct
// names. These floors sit well under that so ordinary work does not trip them,
// but a regex that stops matching cannot pass them.

describe("IPC contract: the parsers actually found the sources", () => {
  test("the Rust side yields a full command set", () => {
    expect(defined.size).toBeGreaterThanOrEqual(100);
    expect(registered.length).toBeGreaterThanOrEqual(100);
    // Spot-check across four different Rust files, so a parser that only ever
    // matched commands.rs would fail here.
    for (const known of ["read_store", "pty_spawn", "sftp_list", "companion_start"]) {
      expect(defined.has(known), `${known} not found by parseTauriCommands`).toBe(true);
      expect(registeredNames.has(known), `${known} not found in generate_handler!`).toBe(true);
    }
  });

  test("the JS side yields a full call-site set", () => {
    expect(namedSites.length).toBeGreaterThanOrEqual(150);
    expect(calledNames.size).toBeGreaterThanOrEqual(90);
    expect(calledNames.has("list_directory")).toBe(true);
  });
});

// ── The contract ────────────────────────────────────────────────────────────

describe("IPC contract: JS call sites resolve to real Rust commands", () => {
  test("every invoke(\"name\") names a defined command", () => {
    const bad = namedSites
      .filter((c) => !defined.has(c.name))
      .map((c) => `${c.at} invoke("${c.name}") has no #[tauri::command] fn by that name`);
    expect(bad).toEqual([]);
  });

  test("every invoke(\"name\") names a REGISTERED command", () => {
    // Defined but unregistered is the sharper failure: it compiles, it is
    // grep-able, and it fails only at runtime with "command not found".
    const bad = namedSites
      .filter((c) => !registeredNames.has(c.name))
      .map((c) => `${c.at} invoke("${c.name}") is not in generate_handler!`);
    expect(bad).toEqual([]);
  });

  test("no invoke() call site has a computed command name", () => {
    // A dynamic first argument is invisible to the two checks above, so the set
    // of them is pinned at empty rather than skipped: one `invoke(name)` would
    // silently take a command back out of this test's reach.
    //
    // The 2026-08-21 baseline scan reported one dynamic site here
    // (ipc-manifest.json, `dynamic: {cmd: ["src/backend.js:23"]}`). That line is
    // `export function invoke(cmd, args)`, the DECLARATION of the @backend
    // seam, not a call through it. There are none.
    expect(callSites.filter((c) => c.dynamic).map((c) => c.at)).toEqual([]);
  });
});

describe("IPC contract: Rust registrations are backed by real fns", () => {
  test("every command in generate_handler! is defined somewhere", () => {
    const bad = registered
      .filter((r) => !defined.has(r.name))
      .map((r) => `lib.rs:${r.line} ${r.name} is registered but has no #[tauri::command] fn`);
    expect(bad).toEqual([]);
  });

  test("every #[tauri::command] fn is registered", () => {
    // An unregistered command is unreachable from the webview: this crate has
    // no other consumer of them, so one is either dead or a forgotten wire-up.
    const bad = [...defined.entries()]
      .filter(([name]) => !registeredNames.has(name))
      .map(([name, at]) => `${at} ${name} is defined but missing from generate_handler!`);
    expect(bad).toEqual([]);
  });

  test("no command is registered without a caller, beyond the known four", () => {
    const orphans = registered
      .map((r) => r.name)
      .filter((n) => !calledNames.has(n) && !(n in UNCALLED_BY_DESIGN));
    expect(orphans).toEqual([]);
  });

  test("the uncalled allow-list has not rotted", () => {
    // Keeps the exemptions honest in both directions: an entry that is no
    // longer registered is stale, and an entry that DID get a caller should be
    // dropped rather than left implying the command is dead.
    for (const name of Object.keys(UNCALLED_BY_DESIGN)) {
      expect(registeredNames.has(name), `${name} is allow-listed but no longer registered`).toBe(true);
      expect(calledNames.has(name), `${name} now has a caller; drop it from UNCALLED_BY_DESIGN`).toBe(false);
    }
  });
});

// ── Parser fixtures ─────────────────────────────────────────────────────────
//
// The corpus assertions above can only be trusted if the parsers can fail.
// These pin the exact failure modes that would make them pass vacuously.

describe("parseTauriCommands", () => {
  test("finds pub / pub async / bare fns and skips intervening attributes", () => {
    const src = [
      "#[tauri::command]",
      "pub fn read_store(app: AppHandle) -> String { }",
      "#[tauri::command]",
      "pub async fn pty_spawn() {}",
      "#[tauri::command]",
      "#[allow(clippy::too_many_arguments)]",
      "fn bare_one() {}",
    ].join("\n");
    expect(parseTauriCommands(src)).toEqual([
      { name: "read_store", line: 2 },
      { name: "pty_spawn", line: 4 },
      { name: "bare_one", line: 7 },
    ]);
  });

  test("ignores #[tauri::command] written inside a doc comment", () => {
    // Five doc comments in the crate discuss `#[tauri::command]` in prose
    // (commands.rs, share.rs, sshconfig.rs, sync_git.rs, vault.rs). Counting
    // those would inflate `defined` with the next unrelated fn in the file.
    const src = [
      "/// A non-async `#[tauri::command]` runs INLINE on the UI thread, so:",
      "fn helper_not_a_command() {}",
      "// #[tauri::command]",
      "fn also_not_a_command() {}",
    ].join("\n");
    expect(parseTauriCommands(src)).toEqual([]);
  });
});

describe("parseGenerateHandler", () => {
  test("strips module paths and keeps the wire name", () => {
    const src = [
      "        .invoke_handler(tauri::generate_handler![",
      "            commands::read_store,",
      "            set_summon_shortcut,",
      "            mcp::manager::mcp_reconnect,",
      "        ])",
    ].join("\n");
    expect(parseGenerateHandler(src).map((r) => r.name)).toEqual([
      "read_store",
      "set_summon_shortcut",
      "mcp_reconnect",
    ]);
  });

  test("throws rather than returning [] when the macro is missing", () => {
    // A silent [] would make "every registered command is defined" pass while
    // checking nothing at all.
    expect(() => parseGenerateHandler("fn main() {}")).toThrow(/no `generate_handler!\[` found/);
    expect(() => parseGenerateHandler("generate_handler![ commands::x,")).toThrow(/not closed/);
  });
});

describe("stripJsComments", () => {
  test("removes line and block comments but preserves line count", () => {
    const src = ["const a = 1; // trailing", "/* block", "   still block */ const b = 2;", "const c = 3;"].join("\n");
    const out = stripJsComments(src);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).not.toContain("trailing");
    expect(out).not.toContain("still block");
    expect(out).toContain("const b = 2;");
    expect(out).toContain("const c = 3;");
  });
});

describe("parseInvokeCalls", () => {
  test("reports name and 1-indexed line for each literal form", () => {
    const src = [
      'invoke("read_store");',
      "invoke('pty_kill', { id });",
      "invoke(`sftp_list`);",
    ].join("\n");
    expect(parseInvokeCalls(src)).toEqual([
      { name: "read_store", line: 1, dynamic: false },
      { name: "pty_kill", line: 2, dynamic: false },
      { name: "sftp_list", line: 3, dynamic: false },
    ]);
  });

  test("ignores invoke() written inside a comment", () => {
    // The real instance this defeats: ProjectSidebar.jsx's P2-T4 comment says
    // "ONE batched invoke (chunked scoped threads ...)", which a naive scan
    // reads as a dynamic call site.
    const src = [
      "// P2-T4: ONE batched invoke (chunked scoped threads on the Rust side)",
      '/* invoke("not_a_command") */',
      'invoke("list_directory");',
    ].join("\n");
    expect(parseInvokeCalls(src)).toEqual([{ name: "list_directory", line: 3, dynamic: false }]);
  });

  test("flags an identifier first argument as dynamic", () => {
    expect(parseInvokeCalls("const p = invoke(cmd, args);")).toEqual([
      { name: null, line: 1, dynamic: true },
    ]);
  });

  test("skips the @backend seam's own declaration and its aliased import", () => {
    // Both live in src/backend.js. Neither is a call site; treating either as
    // one is how the baseline scan grew a phantom dynamic entry.
    const src = ["export function invoke(cmd, args) {", "  return tauriInvoke(cmd, args);", "}"].join("\n");
    expect(parseInvokeCalls(src)).toEqual([]);
  });
});
