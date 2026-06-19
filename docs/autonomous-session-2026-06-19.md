<!-- (C) Claude Opus 4.8 — autonomous overnight session 2026-06-19 -->
# Autonomous hardening session, 2026-06-19

Pluto asked for an overnight autonomous pass: make the app "perfect and working,"
test everything testable without a human, then hand the human-only checks back.
This is the morning briefing.

## TL;DR

- **No code was lost.** Safety anchors were created before any change (see Rollback).
- Baseline verified green: frontend build, 35 vitest tests, `cargo check`, 11 Rust
  lib tests plus the MCP mock-server integration test, clippy clean on touched modules.
- An adversarial 3-reviewer pass on the **newest, least-verified code** (cloud-sync
  engine, MCP native-agent, LLM tool-calling, welcome-banner) found **1 CRITICAL,
  4 HIGH, and several MED/LOW** real issues.
- Fixed the safely-fixable ones TDD-style (a test reproduces the bug first), each
  gated on a green build, each a small forward-only commit. **6 commits.**
- A second adversarial re-review of my OWN diff found **0 hard regressions** and one
  over-broad guard, which I then narrowed (also committed).
- A full release build was run and produced a working MSI (see Release artifact).
- Subtle merge-semantics items needing a product decision were **documented, not
  auto-changed** (see Deferred), to avoid introducing new data-loss while you slept.

## Commits this session (on `001-remote-sessions-parity`, NOT yet pushed)

| sha | sev | what |
|-----|-----|------|
| `4783d9d` | CRITICAL | sync: mass-delete guard, empty/corrupt store read no longer wipes the fleet |
| `0e53cae` | HIGH x3 | sync: first-sync LWW, push-decision ping-pong, bounded push retry |
| `b0e204d` | HIGH | mcp: per-server connection lock, one slow tool call no longer stalls all servers |
| `7ff67d1` | LOW | ui: clear pending welcome-banner redraw timer on pane dispose |
| `aa2d07f` | (re-review) | sync: narrow mass-delete guard to unloaded stores |

(Plus this doc.)

### What each fix actually prevents

1. **CRITICAL, fleet wipe.** `deriveLocal` turned every snapshot item absent from
   the current read into a fresh delete-tombstone. A corrupt localStorage blob (the
   `st`/`userSt` loaders catch a parse error and return `{}`) made a single empty
   read manufacture a mass-delete that won the merge and propagated a wipe of your
   snippets, custom themes, and macros to **every** synced machine. Now guarded: an
   unloaded store carries the snapshot forward instead of deleting.
2. **HIGH, first-sync clobber.** A fresh machine stamped its local defaults `now`
   and overwrote your real settings everywhere on first sync. Now first sync stamps
   at 0 so the established remote wins scalar ties; collections still union (no loss).
3. **HIGH, push ping-pong.** The "is local newer?" check compared timestamps, so two
   machines with identical data pushed to each other forever. Now compares
   meta-insensitive values; pushes only on a real change.
4. **HIGH, silent unpushed edits.** Non-fast-forward push retried exactly once; a
   third machine racing left your edits unpushed under a generic error. Now a bounded
   retry that surfaces a real failure instead of dropping the edit.
5. **HIGH, MCP stall.** One slow or hung MCP tool call held the global lock and froze
   every other MCP server. Now per-server locks; different servers run concurrently.
6. **LOW**, dangling banner-redraw timer cleared on unmount.

## Release artifact (verified)

`npm run tauri build` (Strawberry perl on PATH) finished the optimized Rust build in
9m08s and produced:

- `src-tauri/target/release/plutos-terminals.exe` (37 MB)
- `src-tauri/target/release/bundle/msi/Pluto's Terminal_0.4.3_x64_en-US.msi` (16 MB)

The MSI built cleanly via WiX `light`. The NSIS leg then failed on the
`NSISCOMCALL` apostrophe (the documented gotcha) AFTER the MSI was already produced,
so the MSI is good. Note the new MSI is ~16 MB vs the Jun-10 v0.4.3's 13.7 MB,
reflecting the added sync/MCP/agent code. Still unverified by hand: that the MSI
installs and launches (see checklist F).

## Rollback (if anything looks wrong)

Nothing should, every commit passed build plus tests, but the pre-session state is
anchored two ways at commit `241439c`:

```
git tag      -> auto-safety-2026-06-19
git branch   -> backup/pre-auto-2026-06-19
# full reset:  git reset --hard auto-safety-2026-06-19
# inspect one fix:  git show <sha>
```

No history was rewritten, nothing force-pushed, no branch deleted. The branch has
NOT been pushed to `origin`/`private` yet, that is your call after the checks below.

---

## HUMAN-TEST CHECKLIST (needs the GUI, live servers, or a second machine)

These could not be verified without a display, credentials, or a second device.
Run `npm run tauri dev` and work down the list.

### A. Smoke / boot
- [ ] App launches, renders, no blank screen (the v0.1.3 TDZ class of bug).
- [ ] OLED Black default skin renders; sun/moon toggle flips OLED to Light.
- [ ] Open several local terminals; split panes; drag-split; confirm **PTYs survive**
      splits (no reflow/remount kills a live shell).

### B. Welcome banner (commits 241439c/d505c31/22840ad plus my 7ff67d1)
- [ ] New pane shows borderless welcome banner, left-aligned, rule spans content.
- [ ] **Resize the window or split a fresh pane**, banner reprints aligned at the new
      width, no orphaned box border, no flicker. Type a char first, then the banner
      should NOT reprint on later resizes (userHasTyped guard).

### C. Cloud sync (THE risky subsystem, please test with TWO machines)
- [ ] Configure sync (repo URL plus passphrase plus PAT) on machine 1; add snippets,
      a custom theme, a macro; confirm they push.
- [ ] On machine 2 (fresh): enable sync, it should **adopt** machine 1's data, and
      machine 2's unique snippets should survive (union), NOT clobber machine 1.
- [ ] Edit the same setting on both quickly, no infinite push loop or commit spam
      (watch the sync repo history; should converge, not ping-pong).
- [ ] Delete one snippet on machine 1, the delete propagates to machine 2.
- [ ] **Clear ALL snippets** on machine 1, verify behavior is acceptable (it now
      syncs the clear because the store is still loaded; only a *corrupt* store is
      protected). Confirm this matches what you want, see Deferred #1.
- [ ] Sanity: corrupt or clear localStorage on one machine and confirm a sync does
      NOT wipe the other machine (the CRITICAL fix). Hard to stage; optional.

### D. MCP native agent (commits b71466e etc plus my b0e204d)
- [ ] Add 2 MCP servers (one stdio e.g. `claude`, one http). List tools from both.
- [ ] Run an agent turn that calls a tool; confirm the **approval gate** prompts
      (auto-run is off by default) and a denied tool does not execute.
- [ ] With a deliberately slow or hung MCP server, confirm a second server still
      lists and calls (the per-server-lock fix, no global stall).
- [ ] Tool names with dots round-trip to the right tool (the bijective-decode area).

### E. Remote sessions (the feature this branch is named for, code complete, live-gated)
These are the unchecked T-tasks in `specs/001-remote-sessions-parity/tasks.md`:
- [ ] T013: edit an RDP/VNC session host or port and **save** (requires typing into
      the React inputs, the AX harness couldn't drive these; you at the keyboard can).
- [ ] Live **search filtering** by typing in the sidebar search box.
- [ ] T024/T025: MobaXterm dark side-by-side plus full quickstart screenshot set.
- [ ] Live RDP/VNC connect against a real host (deferred, needs a server).

### F. Release artifact
- [ ] Install `Pluto's Terminal_0.4.3_x64_en-US.msi` and confirm it launches.

---

## DEFERRED, real findings I chose NOT to auto-fix (need your call)

I left these rather than risk a worse bug overnight. Each is real but either needs a
product decision or carries merge-semantics regression risk worth your eyes.

1. **Full-collection clear vs corrupt read (sync).** The mass-delete guard now only
   protects an *unloaded* store. For **macros** specifically, the store IS the array,
   so a genuine "clear all macros" and a failed load are indistinguishable, so a
   clear-all-macros currently won't sync (safe bias). Decide if you want an explicit
   "clear-all" confirmation path instead.
2. **Scalar fields have no tombstones (sync).** Deleting a scalar field (vs changing
   it) can't propagate; an unstamped local field can be overwritten by a stale remote.
   Low impact; documented for awareness.
3. **`CorruptBlobError` not surfaced distinctly (sync, LOW).** A truncated remote blob
   reports a generic error instead of "corrupt sync repo." Cosmetic; 3-line fix when
   you want it (import the class, branch in `syncNow`'s catch).
4. **Non-bijective `__` tool-name encoder (mcp, MEDIUM).** A tool name containing a
   literal `__` round-trips wrong. **Fails safe** (misses lookup, gets gated as
   "unknown tool"), and the limitation is already commented in `llm_tools.rs`. MCP
   names rarely use `__`. Fix = escape `_` before encoding, or keep a per-turn map.
5. **Auto-run shell denylist is best-effort (mcp, MEDIUM).** Off by default. If you
   ever ship Auto-run, relabel it "best-effort, not a security boundary" or switch to
   an allowlist, the denylist misses many destructive commands.
6. **MCP tool results sent back as full `JSON.stringify(CallToolResult)` (mcp, LOW).**
   Token bloat; extract `content[].text` instead. Behavior-affecting, so left for you.

## What I did NOT touch (sync/MCP session)
- No vault notes or docs edited.
- Older, already-audited subsystems (pty.rs, companion.rs, rdp/vnc, sftp), they went
  through the 2026-06-09 full audit; I focused the review on the unverified new code.
- No version bump, no release, no push to remotes.

---

# Pre-distribution security audit (2026-06-19, second pass)

You asked for a full senior-engineer security audit of the downloaded app. I ran an
8-dimension multi-agent audit (IPC/capabilities, command injection, path traversal,
secrets, network/TLS, companion server, untrusted-input, supply-chain), adversarially
verified every finding, then dedup'd 30 findings down to ~10 root issues. Then I fixed
the ones that are safely fixable AND verifiable without a GUI, and re-reviewed my own
fixes (which caught 2 regressions I then fixed). The honest headline: there is **no
currently-reachable RCE in the shipped build** (zero XSS sinks were found in the
frontend), but several real holes and one systemic defense-in-depth gap.

## Security fixes landed (5 commits, all test-gated, forward-only)

| sha | sev | fix |
|-----|-----|-----|
| `55d0a41` | HIGH x2 | mcp_install cmd-injection (reject cmd metacharacters before `cmd /c`); agent Auto-run shell now ALWAYS asks (denylist was evadable) + false UI copy fixed |
| `ebf91fc` | HIGH+MED | README points to `SHA256SUMS` instead of "click through SmartScreen"; release CI generates `SHA256SUMS`; LLM key refused to non-https/public endpoints; companion XFO/nosniff/Referrer headers |
| `0c7ae14` | MED | companion `list_directory` home-jail now fails closed on a canonicalize error |
| `f42c00c` | (re-review) | fixed a userinfo host-spoof I introduced in the LLM guard; clearer mcp_install error |
| `d861099` | (re-review) | re-parse base_url with `reqwest::Url` to kill the whole host-spoof class (#/? variants) |

The re-review catching `f42c00c`/`d861099` is the point: my first LLM-key fix had a
`http://localhost:x@evil.com` bypass that re-opened the exact hole. It is now parser-
robust with 12 boundary tests.

## Verified clean (completeness-critic items)
- **No auto-updater is configured** (no `tauri-plugin-updater`, no `updater` config). So
  there is NO unsigned-auto-update RCE. The flip side is an operational gap: users must
  re-download to update.
- **Local file-write commands are safe:** `write_store` is a fixed path, `save_text_to_file`
  is gated by a native OS save dialog (user picks the path), `open_path` rejects control
  chars and uses explorer.exe (not `cmd /c start`). No arbitrary-write traversal.
- `npm audit` (prod) is clean except item #4 below.

## DEFERRED security items (need your decision, a cert, or GUI/editor testing)

I did NOT auto-fix these. Each is real; each either needs a purchase, a UX design, or
testing I can't do headless. Ordered by download-app risk.

1. **Code-signing certificate (HIGH).** The checksum mitigation is in, but unsigned
   binaries still mean the OS can't attest origin. Get an **EV cert or Azure Trusted
   Signing** (OV won't clear SmartScreen reputation immediately) and wire
   `bundle.windows.certificateThumbprint`/`signCommand` + macOS Developer ID +
   notarization. This is a spend + CI-secret decision. Until then, halt further public
   download promotion.
2. **Companion loads xterm from the jsdelivr CDN with no SRI (HIGH).** On a roaming
   phone's hostile network, a TLS-MITM or CDN compromise injects script into the page
   that holds the shell-access token = desktop RCE. I added safe headers but did NOT
   vendor, because xterm ships **UMD-only** (`lib/xterm.js`, no ESM), so rewriting the
   module loader is not safe to do blind. **Fix:** copy `node_modules/@xterm/xterm/lib/
   xterm.js` + `node_modules/@xterm/addon-fit/lib/addon-fit.js` + the css into
   `companion-web/`, serve them via `include_str!` routes in companion.rs, switch the
   index.html imports from the CDN to classic `<script src="/xterm.js">` + the UMD
   globals, then add a strict CSP. Must be browser-smoke-tested (verify the companion
   terminal still renders) before trusting it.
3. **All 88 IPC commands are ungated from the webview (systemic, ROOT-A).** Tauri v2
   does not ACL app-defined commands and `build.rs` generates no app manifest, so the
   CSP is the entire privilege boundary. **Not exploitable today** (no XSS sink), but a
   single future XSS = full RCE (`pty_spawn`) + keychain theft (`secret_get`). Fix is
   architectural: adopt the app-ACL manifest (deny-by-default) in build.rs + per-command
   `allow-*` permissions, AND a Rust-side gate on `pty_spawn`/`secret_get`. I did NOT
   do this because (a) the ACL list must cover all 88 commands or release builds
   silently reject the missed one (needs a full command-coverage smoke test), and (b) a
   blocking gate on `pty_spawn` would break normal terminal opening unless designed with
   a user-gesture token. Needs you + testing.
4. **Monaco bundles a vulnerable DOMPurify (XSS).** `npm audit` flags DOMPurify (pulled
   in by monaco-editor) with multiple mutation-XSS / prototype-pollution advisories.
   Given ROOT-A, this is the **most important residual XSS vector** if Monaco ever
   renders untrusted markdown/HTML. Fix: pin a patched dompurify via a package.json
   `overrides` entry (then smoke-test the editor), or move monaco to a patched line. I
   did not change the dep because I can't test the editor headlessly.
5. **VNC: no transport encryption + silently accepts no-auth / legacy DES (MED).** On an
   untrusted network this is trivial MITM + credential capture. Fix: don't auto-select
   `AuthMethod::None` (require explicit opt-in), and steer VNC through the existing SSH
   `port_forward_start` by default. Changes connection UX, needs a toggle + testing.
6. **RDP/SSH first-connect TOFU auto-trusts silently (MED).** RDP disables TLS chain +
   hostname validation and pins on first sight with no prompt, so a first-connect MITM
   harvests CredSSP/NTLM. Fix: show the SPKI SHA-256 fingerprint and require explicit
   accept before persisting (like OpenSSH `accept-new`). Needs a new IPC/UI round-trip.
7. **Agent Auto-run trusts a server-declared `read_only` MCP hint (MED).** A malicious
   MCP server can self-classify a destructive tool as read-only and auto-run it. The
   shell fix (`55d0a41`) closes the bigger hole; this needs a per-server trust model.
8. **Release pipeline (MED):** add `actions/attest-build-provenance` and pin every
   GitHub Action to a commit SHA (currently `@v4`/`@stable`/`@v0` floating tags). I
   added `SHA256SUMS` but did not pin the actions, because pinning to a wrong SHA breaks
   CI and I couldn't look up the correct commit SHAs headlessly.
9. **`secret_get(account)` reads any keychain entry (MED, ROOT-A).** Flat namespace; a
   compromised webview could read every stored credential. Namespace-scoping risks
   orphaning existing stored secrets without a migration, so it needs care.

## Updated human-test note (security)
- Agent Mode: with Auto-run on, a **shell command now always shows the approval box**
  (even a benign `ls`). That is intended. Read-only MCP tools still auto-run. Confirm
  the agent loop still completes goals with this gating.
- After installing the next build, the companion page (if you use it) should still load
  and render the terminal. If you apply the vendoring fix (#2), re-test that first.
- The release CI now attaches `SHA256SUMS`; do a test release and confirm it appears.
