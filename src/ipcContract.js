// (C)
// IPC contract parsers: the pure half of `ipcContract.test.js` (audit TQ-5 /
// forward-risk FR2).
//
// Why this exists: nothing in either suite verified that a JS `invoke("name")`
// names a command the Rust side actually registers. The 2026-08-21 audit found
// 88 of 104 commands named in no test on either side, and a rename on either
// side of the boundary (or a `generate_handler!` line dropped during a merge)
// stays green in both suites and surfaces only when a human opens that feature.
//
// These functions take SOURCE TEXT, not paths, so the test does the IO and the
// parsing stays unit-testable against fixtures. That split matters here: a
// source-scanning test whose regex quietly stops matching passes vacuously
// forever, so the parsers get their own fixture tests and the corpus assertions
// carry floors.
//
// Deliberately NOT imported by any app code. It is test support that happens
// to live next to the sources it reads. It imports nothing, so nothing in the
// bundle can pick it up by accident.

// A `#[tauri::command]` attribute on its own line. Anchored and exact so the
// five prose mentions of `#[tauri::command]` in doc comments across the crate
// (commands.rs, share.rs, sshconfig.rs, sync_git.rs, vault.rs) are not counted
// as definitions.
const CMD_ATTR = /^\s*#\[tauri::command\]\s*$/;

// `pub fn` / `pub async fn` / `pub(crate) fn` / bare `fn`, capturing the name.
const FN_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;

// How far past the attribute to look for the fn. More attributes (#[allow],
// #[cfg]) and multi-line doc comments can sit between them.
const FN_LOOKAHEAD = 8;

/**
 * Every `#[tauri::command]` fn defined in one Rust source file.
 * @returns {{name: string, line: number}[]} 1-indexed line of the `fn` itself.
 */
export function parseTauriCommands(rustSource) {
  const lines = rustSource.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CMD_ATTR.test(lines[i])) continue;
    const end = Math.min(i + 1 + FN_LOOKAHEAD, lines.length);
    for (let j = i + 1; j < end; j++) {
      const m = lines[j].match(FN_DECL);
      if (m) {
        out.push({ name: m[1], line: j + 1 });
        break;
      }
    }
  }
  return out;
}

/**
 * Every command registered in `tauri::generate_handler![...]`, module path
 * stripped (`mcp::manager::mcp_reconnect` -> `mcp_reconnect`) because that last
 * segment is the wire name the webview calls.
 *
 * Throws when the macro or its closing `])` is missing rather than returning
 * `[]`: an empty registration list would make "every invoke resolves" fail in a
 * confusing way and "every registered command is defined" pass vacuously.
 * @returns {{name: string, line: number}[]}
 */
export function parseGenerateHandler(libSource) {
  const open = libSource.indexOf("generate_handler![");
  if (open < 0) throw new Error("lib.rs: no `generate_handler![` found");
  const close = libSource.indexOf("])", open);
  if (close < 0) throw new Error("lib.rs: `generate_handler![` is not closed by `])`");
  const before = libSource.slice(0, open).split(/\r?\n/).length; // 1-indexed line of the macro
  const body = libSource.slice(open, close);
  const out = [];
  body.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*([a-z_][a-z0-9_]*)\s*,\s*$/);
    if (m) out.push({ name: m[1], line: before + i });
  });
  return out;
}

/**
 * Strip `//` and block comments, preserving line count and column offsets so
 * reported line numbers stay usable.
 *
 * String context is deliberately NOT tracked. A `//` inside a string literal
 * truncates the rest of that line, which can only ever LOSE a call site, never
 * invent one, and the corpus floor in ipcContract.test.js is what catches it
 * if that ever starts happening. Tracking quotes instead would mis-handle the
 * apostrophes in JSX prose and the `"` inside the inline SVG path data in
 * toolbarIcons.jsx, which is the more dangerous failure.
 */
export function stripJsComments(jsSource) {
  const lines = jsSource.split(/\r?\n/);
  let inBlock = false;
  return lines
    .map((line) => {
      let out = "";
      let i = 0;
      while (i < line.length) {
        if (inBlock) {
          const end = line.indexOf("*/", i);
          if (end < 0) {
            out += " ".repeat(line.length - i);
            i = line.length;
          } else {
            out += " ".repeat(end + 2 - i);
            i = end + 2;
            inBlock = false;
          }
          continue;
        }
        const block = line.indexOf("/*", i);
        const eol = line.indexOf("//", i);
        if (eol >= 0 && (block < 0 || eol < block)) {
          out += line.slice(i, eol);
          i = line.length;
        } else if (block >= 0) {
          out += line.slice(i, block);
          i = block + 2;
          inBlock = true;
        } else {
          out += line.slice(i);
          i = line.length;
        }
      }
      return out;
    })
    .join("\n");
}

// `invoke(` immediately followed by a string literal (the wire name) or by an
// identifier (a pass-through wrapper, see `dynamic` below).
//
// The lookbehind rejects `tauriInvoke(` and any `obj.invoke(`, so the alias
// import in backend.js is not counted as a second transport.
const INVOKE_CALL =
  /(?<![\w$.])invoke\(\s*(?:"([^"]+)"|'([^']+)'|`([^`${}]+)`|([A-Za-z_$][\w$]*))/g;

// `export function invoke(cmd, args)` in backend.js is the DECLARATION of the
// seam, not a call through it. Counting it produced a phantom "1 dynamic call
// site" in the 2026-08-21 baseline scan (ipc-manifest.json's `dynamic` entry);
// the real dynamic hop is `tauriInvoke(cmd, args)` one line below, which the
// lookbehind above already skips.
const FN_DECL_BEFORE = /\bfunction\s+$/;

/**
 * Every `invoke(...)` call site in one JS/JSX source file.
 *
 * A site whose first argument is an identifier rather than a literal is
 * reported with `dynamic: true` and no name. Those are invisible to the name
 * check, so the test pins the exact set of them instead of ignoring them.
 * @returns {{name: string|null, line: number, dynamic: boolean}[]}
 */
export function parseInvokeCalls(jsSource) {
  const out = [];
  stripJsComments(jsSource)
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(INVOKE_CALL)) {
        if (FN_DECL_BEFORE.test(line.slice(0, m.index))) continue;
        const name = m[1] ?? m[2] ?? m[3] ?? null;
        out.push({ name, line: i + 1, dynamic: name === null });
      }
    });
  return out;
}
