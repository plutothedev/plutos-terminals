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

## What I did NOT touch
- No vault notes or docs edited.
- Older, already-audited subsystems (pty.rs, companion.rs, rdp/vnc, sftp), they went
  through the 2026-06-09 full audit; I focused the review on the unverified new code.
- No version bump, no release, no push to remotes.
