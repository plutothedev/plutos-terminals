<!-- (C) -->
# Stream D: Gist Block/Transcript Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** right-click a command block (or a tab → whole-session transcript) → a secret-scanned preview of exactly what will leave the machine → confirm → a GitHub gist is created and its URL copied to the clipboard, with a machine-local "My shares" list to revoke.

**Architecture:** `secretScan.js` (Stream A, reused as-is) masks the preview; a bespoke `ShareModal` (on `Modal.jsx`) shows exact text + masked-secret warnings + secret/public toggle + label-flipping submit; a net-new Rust `share.rs` does the gist `POST`/`DELETE` (reqwest, mirroring `llm.rs`), authed by `gh auth token` or a keychain PAT (`github-gist-pat:v0`, gist scope); `transcript_read`/`transcript_list` Rust commands (mirroring Stream C notebook IO) back the transcript-share path; a `SharingSection` (Settings) holds the PAT; share history lives machine-local in `userSt` (NOT synced).

**Grounding:** the 2026-07-21 Stream D integration map + the corrected spec Stream D section. Verified refs @ ~4729699: block records `TerminalPane.jsx:826-935` (NO cached output — re-read from `term.buffer.active`), `blockText()` helper `TerminalPane.jsx:1642-1655`, block context menu `TerminalPane.jsx:1766-1798` (Copy command/output/both, Re-run), tab context menu `TerminalPanel.jsx:661-707`, `secretScan.js` (`scanSecrets`/`maskSecrets`), transcript writer `commands.rs:970-992` (append-only, NO reader), `scrollback_load` precedent `commands.rs:765-780`, notebook IO precedent `commands.rs:1255-1367`, vault `vault.rs:17-42` (`secret_set/get/delete`, arbitrary account), existing PAT `syncSecrets.js:8-9` (`sync-git-pat:v0`, repo scope — DO NOT reuse), reqwest/`http_error` pattern `llm.rs:11-29,154-236`, reqwest in Cargo.toml:41, `Modal.jsx` + `WorkspacesModal.jsx:14-75` (list-with-per-item-actions precedent), `navigator.clipboard.writeText` (9 sites, e.g. `TerminalPane.jsx:1666`), sync SOURCES `syncState.js:7-11`, `approvedRuleFiles` machine-local test `syncState.test.js:140`, SettingsModal section registration `SettingsModal.jsx:120-124`, AgentSection/SyncSection precedents.

**Build gates (before EVERY commit, unfiltered):** `npm run build` + `npx vitest run` (baseline 211); Rust-touching tasks also `cd src-tauri && cargo check && cargo test`.

**Safety rails:** forward-only commits; no rebase/reset/force-push; push is pluto-only.

## HARD BUILD CONSTRAINT — no live share during the build (READ THIS)

Creating a gist is an outward-facing, irreversible PUBLISH. Every task below is written so that **no `share.rs` gist POST or DELETE is ever executed during implementation or review** — not a test share, not a probe, not a "does my token work" check. The Rust commands are built and unit-tested only for their pure parts (auth resolution logic, request assembly, response parsing) with the actual `reqwest` send NEVER invoked in a test (no network in tests, no live token in the build env). The flow is fully wired; the FIRST real gist is created by pluto, by hand, after pasting a token — that is the manual smoke at D-gate. Any task that "verifies sharing works" by actually POSTing is a plan violation. The POST is reachable in code ONLY through the ShareModal's explicit confirm button.

---

### Task D-1: `share.rs` — gist create/delete (POST never fired in tests)

**Files:** Create `src-tauri/src/share.rs`; Modify `src-tauri/src/lib.rs` (module decl + command registration).

Commands:
- `gist_auth_available() -> { source: "gh" | "pat" | "none", detail }` — checks `gh auth token` via the existing `silent_command` pattern (success + non-empty stdout → "gh"; **gh present but EMPTY stdout → falls through to pat** — test this case); else checks keychain `secret_get("github-gist-pat:v0")` non-empty → "pat"; else "none". Returns the SOURCE only, NEVER the token value. **AUDIT-CRITICAL: `detail` is a FIXED enum of safe display strings ONLY — `"gh CLI"` | `"saved token"` | `"no token found"` — NEVER derived from subprocess stdout/stderr or any token bytes (gh's stdout IS the token). A pure-helper test must assert that for ANY `gh_out` input, the returned struct contains no substring of `gh_out` beyond that fixed vocabulary.**
- `gist_create(filename, content, public: bool) -> { id, url, htmlUrl }` — resolves the token (gh first, then PAT), assembles the `POST https://api.github.com/gists` body `{ description, public, files: { <filename>: { content } } }`, sends via a reqwest client (mirror `llm.rs`: `Client::builder().timeout(30s).user_agent("plutos-terminals").build()`, `.bearer_auth(token)`, `Accept: application/vnd.github+json`), status-checks via a local `http_error`-style helper before parsing, returns `{ id, url (the api url), htmlUrl (html_url) }`. On no auth → `Err("no GitHub token")`.
- `gist_delete(id) -> Result<()>` — `DELETE https://api.github.com/gists/{id}` with the same auth; 404 is treated as already-gone (Ok).
- Split PURE helpers out for testing (the ONLY things tested): `resolve_token_source(gh_ok, gh_out, pat)` → `{ source, detail }` (no IO; detail is the fixed-enum string, NEVER `gh_out`); `build_gist_body(filename, content, public)` → the serde_json::Value (assert shape); `parse_gist_response(json)` → {id,url,htmlUrl} or Err; and a `redact(s)` used on ANY error string surfaced to JS — a reqwest/gh error must never carry the `Authorization` header or token bytes to a toast. The reqwest `.send()` is NEVER called in a test. gist_create/gist_delete map transport errors through `redact` before returning `Err(String)`.

- [ ] TDD: `#[cfg(test)] mod share_tests` for the pure helpers ONLY: token-source resolution precedence (gh non-empty > gh-empty-falls-to-pat > pat > none); **`detail` never contains `gh_out` bytes for any input**; body shape incl. public/secret; response parse incl. missing-field Err; **`redact` strips a token/Authorization-header substring from an error string**. NO test performs a network request. Comment says so explicitly.
- [ ] Implement; register `share` mod + `gist_auth_available`/`gist_create`/`gist_delete` in lib.rs.
- [ ] Gates incl. cargo test; commit `feat(share): gist create/delete Rust commands (no live POST in tests)`.

### Task D-2: `transcript_read` / `transcript_list` (mirror notebook IO)

**Files:** Modify `src-tauri/src/commands.rs` (+ lib.rs registration), tests in-module.

Mirror the notebook IO shape (dir-scoped, name-gated, dated). Transcripts live at `<data_dir>/terminals/transcripts/{date}/{name}.md` (append-only writer already exists at `commands.rs:970-992`).
- **AUDIT: date + name validation is FULL-STRING, never a substring shape-match** (an unanchored `\d{4}-\d{2}-\d{2}` match accepts `"../../etc/2024-01-01"` while the whole string joins into the path). Validate date via `safe_filename(date) == date` AND `date.len() == 10` AND it parses as a real `YYYY-MM-DD` (reconstruction-equality, exactly the `notebook_path` technique). Validate name via `safe_filename(name) == name` (stem allowlist; a transcript name is `<project-or-tab>-<6hex>`, and does NOT carry `.md` — the `.md` is appended by us, unlike notebook_path which requires the caller's `.md`; do NOT require a `.md` suffix on the name).
- **AUDIT: no-follow-symlinks** — `transcript_list_sync` filters entries via `symlink_metadata().file_type().is_file()` (mirror `notebook_list_sync` / the Stream A rule-file skip); read paths reject a symlinked target the same way.
- **AUDIT: lossy UTF-8 decode** — transcripts are ANSI-stripped PTY output and can carry stray non-UTF8 bytes; use `String::from_utf8_lossy` (the `scrollback_load` precedent), NOT strict `read_to_string`, so one bad byte never errors the whole share.
- `transcript_list_sync(dir) -> [{ date, name }]` — walk `transcripts/` one date-dir deep, list `.md` files (is_file, no symlink), name-gate each. Sorted newest-date-first.
- `transcript_read_sync(dir, date, name) -> String` — validate date+name full-string; read one dated file (lossy); Err if absent.
- `transcript_read_all_sync(dir, name) -> String` — validate name; concatenate every dated file for that name across dates, oldest-first, `\n--- <date> ---\n` separator; the "whole session" the share reads.
- Thin async command wrappers computing `<data_dir>/terminals/transcripts`.

- [ ] TDD `#[cfg(test)] mod transcript_read_tests` (tempdir; mirror notebook_io_tests): list empty/missing → []; two dated files for one name → read_all concatenates oldest-first with separators; **traversal rejected FULL-STRING: date `"../../etc/2024-01-01"` (validly-shaped substring but path-escaping) rejected, name `"a/b"`/`"../x"` rejected, date `"2020-13-99"` rejected (not a real date), a name with `..` rejected**; symlinked `.md` not listed (port the rule-file symlink test); single-date read; absent → Err; a file with an invalid UTF-8 byte reads lossy (no Err).
- [ ] Implement + register; gates incl. cargo test; commit `feat(share): dir-scoped transcript read/list commands`.

### Task D-3: `shareText.js` — pure preview assembly + scan

**Files:** Create `src/features/terminals/shareText.js` + `shareText.test.js`.

Pure, reuses `secretScan.js`:
- `buildShare(kind, rawText) -> { filename, masked, hits }` — `hits = scanSecrets(rawText)`, `masked = maskSecrets(rawText, hits)`. **AUDIT-CRITICAL: the filename is CONTENT-INDEPENDENT — it is NEVER derived from the command/title/rawText, because the gist filename is part of the same POST body and a raw title like `curl -H "Authorization: Bearer sk-..."` would leak the secret in the filename even when the content is masked.** Filename = the spec's fixed scheme: `plutos-terminal-share-${dateStamp}.${kind === "transcript" ? "md" : "txt"}` where `dateStamp` is passed in (NOT computed here — pure module; the caller stamps it). Return ONLY `{ filename, masked, hits }` — `raw` is NOT returned (nothing downstream needs it; keeping it out of the return makes a raw-upload structurally harder). The modal shows `masked` and uploads `masked`.
- No `slugFilename` — deleted; the fixed scheme removes the whole title-sanitization surface (and its leak).

Contract pinned by test: `buildShare`'s `filename` is byte-independent of `rawText` (same date → same filename regardless of content, even content containing a secret); and if `hits.length`, `masked` contains no raw secret substring.

- [ ] TDD: buildShare (no secrets → masked==rawText; with an AWS key → masked has `[masked aws-access-key]` and no raw key substring, hits listed; **filename is identical for two different rawTexts with the same dateStamp, and contains no substring of a secret placed in rawText**). red→green.
- [ ] Gates; commit `feat(share): pure share-text assembly + secret masking`.

### Task D-4: block output extraction + `ShareModal` + block menu entry

**Files:** Create `src/features/terminals/ShareModal.jsx`; Modify `src/features/terminals/TerminalPane.jsx` (block menu item + a callback to open the modal with extracted text).

- **Extraction:** in TerminalPane, the "Share block..." menu item (added to the array at `:1781-1785`) calls a new handler that gets `blockText(block, "both")` (existing helper, re-reads the xterm buffer) and opens the ShareModal with `{ kind:"block", title:<command or "block">, rawText }`. ShareModal is rendered near the other TerminalPane modals (or lifted — check where TerminalPane renders its find/search overlay; a local modal state is fine).
- **ShareModal (bespoke on `Modal.jsx`):** props `{ open, kind, title, rawText, onClose }`. **AUDIT: compute `const { filename, masked, hits } = useMemo(() => buildShare(kind, rawText), [kind, rawText])` ONCE per open, and thread the SAME `masked` into both the preview `<pre>` AND the `gist_create` call — never re-derive, never send anything but that memoized `masked`. This is the single load-bearing invariant of the stream.** (`title` is display-only in the header; it is NEVER sent to gist_create — the filename is the fixed content-independent scheme from buildShare.) Shows `masked` in a scroll `<pre>`; if `hits.length`, a red warning row listing each masked secret's NAME (not value) + submit label becomes "Share anyway"; a secret/public radio (default SECRET/unlisted) **with an explicit line: "Secret gists aren't private — anyone with the link can view them until you revoke."**; a "what leaves your machine" heading. Submit: `invoke("gist_auth_available")` → if "none", show the "connect GitHub" state (Settings → Sharing / `gh auth login`), do NOT proceed; else `invoke("gist_create", { filename, content: masked, public })` → on success, `navigator.clipboard.writeText(htmlUrl)`, toast "Gist created, URL copied", append `{ id, url, htmlUrl, title, date, public }` to `userSt.shareHistory` via functional `saveUser`, close. On error, toast the (already Rust-redacted) message, keep the modal open.
- The POST is reachable ONLY here, behind this explicit submit. No auto-share.

- [ ] Gates (component untested per repo norm; build + the D-3 model tests + D-gate smoke are the net); commit `feat(share): ShareModal preview + Share-block menu entry`.

### Task D-5: transcript share entry + "My shares" + revoke

**Files:** Modify `src/features/terminals/TerminalPanel.jsx` (tab menu "Share transcript..." item + resolve the tab's transcript name), reuse `ShareModal`; Create `src/features/terminals/SharesModal.jsx` ("My shares" list); Modify `chrome/MenuBar.jsx` or wherever (a "My shares" opener — put it in the File or Tools menu); Modify `SettingsModal.jsx` + Create `SharingSection.jsx`.

- **Transcript share:** tab menu item computes the transcript name (`transcriptName(projectName, tabId)` pattern — `<project-or-tab>-<last6>`), `invoke("transcript_read_all", { name })`, opens ShareModal with `{ kind:"transcript", title:<tab label>, rawText }`. Empty transcript → toast "nothing recorded yet", no modal.
- **SharesModal (mirror WorkspacesModal):** lists `userSt.shareHistory` rows (title, date, public/secret, url) with Open (browser) + Revoke (confirm → `invoke("gist_delete", { id })` → remove from history) per row. Empty → "no shares yet".
- **SharingSection (mirror SyncSection's PAT field):** a masked Input to paste a gist-scope PAT → `invoke("secret_set", { account: "github-gist-pat:v0", secret })`; a status line from `gist_auth_available` ("using gh CLI" / "using saved token" / "not connected"); a "clear token" button (`secret_delete`). Registered in SettingsModal like AgentSection.
- **shareHistory is machine-local:** stored in `userSt.shareHistory` but MUST NOT be added to sync SOURCES — add a `syncState.test.js` assertion mirroring the approvedRuleFiles one (`expect(u.fields).not.toContain("shareHistory")` and not in collections).

- [ ] TDD: the syncState machine-local lock test (red if someone adds it to SOURCES). Gates; commit `feat(share): transcript share, My-shares list + revoke, Sharing settings (history machine-local)`.

### Task D-6: Stream gate

- [ ] Full gates everywhere (npm build + vitest + cargo check + cargo test); report counts.
- [ ] CHANGELOG Unreleased: a "Sharing" bullet — no overclaim (secret-scanned preview before upload, secret-gist default, machine-local history, no entropy heuristic v1).
- [ ] Also fold the stale-comment cleanup (`secretScan.js:6` still says entropy heuristics live with Stream D — now dropped per spec; correct it in a D commit).
- [ ] Whole-stream review (code-reviewer over the D diff): SECURITY LENS is primary — (a) the POST body's CONTENT **and FILENAME** are both content-safe: content is the masked text, filename is the fixed content-independent scheme (never a slug of raw title) — trace every path from ShareModal to gist_create; (b) no path fires a gist POST/DELETE without the explicit modal confirm (grep for gist_create/gist_delete callers); (c) the token is never returned to JS / never logged / never in an error string — `gist_auth_available.detail` is the fixed enum, gist errors go through `redact`; (d) transcript_read date+name validation is FULL-STRING (construct a `../`-embedding date and confirm rejection) + symlink no-follow; (e) shareHistory not in SOURCES (test-pinned + structurally via readSurface/writeSurface); (f) the "no live POST in tests/build" constraint held (no test does a real request); (g) the ShareModal memoizes buildShare once and sends only that `masked`. Fix findings; re-review every fix.
- [ ] Manual smoke list for PLUTO (this is where the FIRST real share happens — pluto only): paste a gist-scope PAT in Settings → Sharing (or `gh auth login`); right-click a command block → Share block → verify the preview shows exactly the text, a fake `sk-...` in the output shows masked + "Share anyway"; confirm → gist created, URL copied, opens correctly, content is the MASKED text; My shares lists it; Revoke → gist 404s; Share transcript on a tab → whole session uploads; secret vs public toggle respected. **Claude never performs a live share.**
