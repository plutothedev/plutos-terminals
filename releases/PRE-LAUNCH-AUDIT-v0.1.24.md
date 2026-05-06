# Pre-launch test audit — v0.1.24

Comprehensive static analysis + code-path verification before YouTube video recording. Companion to v0.1.21–v0.1.24 polish releases.

## Summary

**Ship-blockers found:** 0
**Real issues found + fixed:** 1 (example.deck.json systemPrompt — fixed in v0.1.24)
**Acceptable risks for Windows-only release:** 4 minor PowerShell-isms in echo banners + Session journal

The app is launch-ready. Pre-existing risks are documented and acceptable for the v1 Windows-only release.

## Pack file validation (11 / 11)

| Pack | JSON | Schema | Layout | systemPrompts | Word count |
|---|---|---|---|---|---|
| claude-code-basic | ✓ | ✓ | 1×1 | 1 | 36 |
| codebase-explorer | ✓ | ✓ | 2×(1+1) | 1 | 81 |
| content-script-writer | ✓ | ✓ | 2×(1+1) | 1 | 182 |
| debug-session | ✓ | ✓ | 2×(1+1) | 1 | 103 |
| dual-claude-pair | ✓ | ✓ | 2×(1+1) | 2 | 60 + 46 |
| example | ✓ | ✓ | 2×(1+1) | 1 | 0 *(cleared v0.1.24)* |
| interview-prep | ✓ | ✓ | 2×(1+1) | 1 | 177 |
| language-learning | ✓ | ✓ | 1×1 | 1 | 167 |
| rubber-duck | ✓ | ✓ | 1×1 | 1 | 198 |
| trading-workflow | ✓ | ✓ | 3×(1+1+1) | 1 | 94 |
| writing-helper | ✓ | ✓ | 1×1 | 1 | 99 |

## Code-path integrity (22 / 22 verified)

### TerminalsTab.jsx (orchestrator)
- ✓ `applyPack` defined + reads `t.systemPrompt` correctly
- ✓ `applyPack` persists `recentPacks` (capped at 5, deduped by name)
- ✓ Drag-drop overlay state + JSX both wired
- ✓ Command palette state + mount + pack search modal mount + `spawn_new_window` invoke present
- ✓ User-level state (`userSt`/`saveUser`) propagates to SettingsModal + SetupChecker
- ✓ Recording start/stop/cap state all wired; cap-hit indicator switches to `⚠ rec capped — save`
- ✓ Session restore toast + reset workspace + new window commands present
- ✓ `data-phn-skin` attribute applied on outermost div; `xtermTheme` flows down to TerminalPanel/TerminalPane; `pureBlackTerminal` flag respected
- ✓ Dead button-style imports removed (`getButtonStyleId` / `applyGlobalButtonStyle` no longer in TerminalsTab)

### TerminalPane.jsx (PTY + xterm + recording)
- ✓ Pre-flight `claude` check fires when any startCommand starts with "claude"
- ✓ When pre-flight fails: skips BOTH `startCommands` AND `systemPrompt` write (user gets a clean shell + clear ANSI-colored install instructions)
- ✓ `systemPrompt` written 2 seconds after startCommands run (line 484: `sysPrompt.trim() + "\r"`)
- ✓ Recording `pushOutput(tabId, payload)` called on every PTY data chunk; no-op when no active recording for that tab
- ✓ `extra_env` injection reads `plutos-terminals:user:v0` first (post-v0.1.21 location for `anthropicKey`); falls back to `plutos-terminals:state:v0` for legacy users not yet migrated
- ✓ xterm theme prop applied via `term.options.theme = xtermTheme` on prop change

### App.jsx (entry + user state)
- ✓ `USER_STORAGE_KEY` constant + `readUserState`/`writeUserState` helpers
- ✓ Migration block in `useState` initializer — synchronous, no Welcome flicker for upgrading users
- ✓ Cross-window `storage` event listener — window 1 dismisses tour → window 2 picks it up without refresh
- ✓ `applyGlobalSkin(skinId)` + `applyGlobalLayout(layoutId)` wired in useEffects
- ✓ `applyGlobalButtonStyle("bracket")` hardcoded (button-style picker fully retired in v0.1.20)
- ✓ Welcome reads `userSt.welcomeDone`; secondary windows skip welcome because they share user state

## systemPrompt quality grades (10 / 10 ready)

After v0.1.23's tuning pass on the four newer packs (`language-learning`, `interview-prep`, `content-script-writer`, `rubber-duck`), all 10 prompts are launch-ready. Each was evaluated on:

- Will Claude follow the role on first prompt?
- Will Claude break character under common pressure?
- Are anti-patterns covered?
- Is opening behavior anchored?

| Pack | Grade | Strongest signal |
|---|---|---|
| claude-code-basic | ✓ | "Default to clear, runnable answers" + cite file paths + ask one clarifying question |
| codebase-explorer | ✓ | "Read first, recommend second" + concrete `'where does X happen'` example + no edits unless asked |
| content-script-writer | ✓ | 4-question intake + cadence anchors (8s hook, 30s value-promise, 1:30 first beat) + numbered hooks |
| debug-session | ✓ | 4-step process (reproduce → hypothesize → verify → fix) + explicit symptom-patch anti-patterns |
| dual-claude-pair | ✓ | Both panes cross-reference each other + role separation explicit |
| interview-prep | ✓ | "Stay neutral mid-loop" (key v0.1.23 fix) + concrete STAR-feedback example |
| language-learning | ✓ | Target-language-for-prompts rule + no-praise constraint + 5–7 exchange anchor |
| rubber-duck | ✓ | Literal opener `'What are you stuck on?'` + load-bearing-assumption def + therapist disclaimer |
| trading-workflow | ✓ | ICT vocabulary loaded + "not signal-calling" risk language |
| writing-helper | ✓ | "Conversation IS the deliverable" + anti-sycophancy explicit |

## Issue found + fixed

### `example.deck.json` systemPrompt was a meta-comment (fixed v0.1.24)

**Symptom:** Loading the example pack auto-typed the schema-explanation text into a shell with no Claude session running, producing a confusing "command not found" error.

**Fix:** Cleared `systemPrompt` to `""`. Schema-reference utility preserved via existing `notes[]` field.

**User impact:** Minimal — README and pack description both warn "schema reference only — go to one of the practical packs." But the glitch is gone.

## Acceptable risks (Windows-only v1)

These are tracked as known limitations for future Mac/Linux ports. None affect the current Windows-only launch:

1. **`trading-workflow` Session journal** uses `$(Get-Date -Format yyyy-MM-dd)` — PowerShell-only. Pack is "Pluto Style" so audience self-selects.
2. **3 echo banners** (`codebase-explorer`, `content-script-writer`, `interview-prep`) suggest PowerShell-style commands inside the banner text. The echoes themselves run cross-platform; only the suggested commands would need translation.

## Conclusion

The app is launch-ready. v0.1.24 ships the one real fix surfaced by the audit. After this, the next moves are operational — record the YouTube walk-through, set up the Discord channel, push wider on social.
