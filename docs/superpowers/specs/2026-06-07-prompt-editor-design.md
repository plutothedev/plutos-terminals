<!-- (C) -->
# Design — App-owned prompt editor (Warp-style input editor)

**Status:** approved design, slice 1 of N.
**Branch:** `001-remote-sessions-parity`. **Date:** 2026-06-07.
**Roadmap:** closes the core of Milestone 2 (the last defining Warp gap). Unlocks inline syntax highlighting now; multiline / autosuggest / completions in later slices.

## Goal

Replace raw keystroke-forwarding at the shell prompt with an **app-owned input editor** (full prompt ownership, the true Warp model). When the shell is at a prompt, the user types into a CodeMirror editor with live syntax highlighting; pressing Enter sends the assembled line to the shell. When a command is running or a full-screen/interactive program is active (vim, less, ssh password, a REPL), the editor gets out of the way and keystrokes pass through to the PTY exactly as today.

Ships **opt-in, default off**, behind a Settings toggle + a remappable keybinding, so it cannot disrupt daily shell use until proven.

## Key decisions (resolved)

1. **Architecture:** full prompt ownership, gated by OSC-133 prompt state.
2. **Slice 1 scope:** single-line editor + syntax highlighting + Enter-to-send + ↑/↓ app history + automatic raw passthrough for interactive/full-screen apps. (Multiline/soft-wrap/click-to-place, ghost-text autosuggest, and inline tab-completions are later slices.)
3. **Rollout:** opt-in, `st.promptEditor` default `false` + a toggle keybinding.
4. **Highlighter:** CodeMirror 6 (shell mode via `@codemirror/legacy-modes`), themed from the existing `--phn-*` tokens. Chosen over a custom tokenizer to future-proof the multiline/selection slices.

## Architecture

### Interception model — focus, not keystroke-fighting
The editor is a DOM overlay (`PromptEditor`) absolutely positioned over the active pane's prompt input area. While at a prompt it holds DOM focus, so keystrokes go to CodeMirror and **never reach xterm** — no need to intercept `term.onData` or `attachCustomKeyEventHandler`. When we leave prompt state, we blur/hide the overlay and refocus xterm, restoring today's raw passthrough.

### Prompt-state machine (OSC-133)
The shell integration in `TerminalPane.jsx` (`promptSetup`) currently emits `133;A` (prompt start) and `133;D;<exit>` (command done), plus `1337;PlutoCmd=<b64>` at preexec. It does **not** emit `133;B` (input start). We add `133;B`:

- **PowerShell:** the prompt function already builds `…]133;D;<code>…]133;A…`; append `…]133;B` to the end of the returned prompt string (after the visible prompt text).
- **bash/zsh:** append `\033]133;B\007` to the end of `PS1`/`PROMPT` (after the powerline segments).

State transitions (per pane):

| Event | New state | Editor |
|---|---|---|
| `133;B` fires | `atPrompt = true` (capture cursor x/y = input origin) | show + focus |
| user presses Enter (line sent) | `atPrompt = false` | hide |
| `133;A` or `PlutoCmd` (command starting) | `atPrompt = false` | hide |
| `term.buffer.active.type === "alternate"` (alt-screen: vim/less) | force off | hide |
| shell has no Pluto integration (no `B` ever) | stays off | never shows → today's behavior |

Alt-screen is watched via `term.buffer.onBufferChange` (or polled on render) to flip to passthrough the instant a full-screen app starts, and back when it exits.

### Send path
On Enter: read the editor's text, `writeToTab(tabId, text + "\r")` (broadcast-aware via the existing `sendToActiveTerminal` rules), clear the editor, set `atPrompt = false`, record the command into the app history store. The shell echoes + runs it → normal OSC-133 block. Empty line → send just `\r`.

### Positioning
On `133;B`, read `term.buffer.active.cursorX/cursorY` and the renderer cell dimensions (`term._core._renderService.dimensions` actual cell width/height, with a robust fallback) to place the overlay at the input origin, spanning to the right edge of the pane. Reposition on `term.onResize`, `term.onScroll`, and pane resize. Single line in slice 1 (overflow scrolls horizontally inside CodeMirror).

### Double-caret avoidance
While the editor is focused, set xterm's cursor inactive/hidden (`term.options.cursorBlink = false` + `cursorInactiveStyle = "none"` or equivalent) so the shell's idle caret doesn't show under the editor. Restore on passthrough.

## Components / files

- **`src/features/terminals/PromptEditor.jsx`** (new) — the CodeMirror overlay. Props: `visible`, `originX/originY`, `cellW/cellH`, `cols`, `theme` (xterm theme for color sync), `history`, `onSubmit(text)`, `onPassthrough(data)` (for keys we choose to forward, e.g. Ctrl+C), `onBlurToTerminal`. Owns the CodeMirror `EditorView`, shell language + a `--phn`/xterm-themed highlight style, and key bindings (Enter, ↑/↓ history, Esc, Ctrl+C, Ctrl+L).
- **`src/features/terminals/promptState.js`** (new) — small per-pane prompt-state helper/state machine + alt-screen detection utilities, so `TerminalPane` stays focused.
- **`src/features/terminals/TerminalPane.jsx`** (changed) — add the `133;B` OSC handler, alt-screen watch, cursor-origin capture, mount `<PromptEditor>` when enabled+atPrompt+active, focus management, and the `B` marker in `promptSetup` (PowerShell + bash/zsh).
- **`src/components/SettingsModal.jsx`** (changed) — "App-owned prompt editor (beta)" toggle writing `st.promptEditor`.
- **`src/features/terminals/keybindings.js`** (changed) — a `togglePromptEditor` action (no default combo, user-assignable) wired through the existing dispatcher.
- **`package.json`** — add CodeMirror 6 deps: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/legacy-modes`.

## Data flow

```
shell prints prompt → emits 133;B
  → TerminalPane OSC handler: atPrompt=true, capture cursorX/Y
  → PromptEditor shown+focused at input origin (xterm caret hidden)
  → user types (CodeMirror, highlighted); ↑/↓ = app history
  → Enter → onSubmit(text) → writeToTab(tabId, text+"\r") → recordCommand(text)
  → atPrompt=false → editor hidden, xterm refocused
  → shell echoes+runs → 133;D block → next prompt → 133;B → repeat
interactive app (alt-screen) or command running → editor hidden → raw xterm passthrough
```

## Edge cases

- **Interactive prompts that aren't full-screen** (e.g. `sudo` password, `read`, `npm init` Q&A): these happen *after* a command starts, so `atPrompt` is already false → passthrough. The editor only owns the shell's top-level prompt.
- **Ctrl+C at the editor:** forward `\x03` to the PTY and clear the editor.
- **Ctrl+L:** clear the screen (send `\f` / `clear`) — keep parity.
- **Paste:** multi-line paste in slice 1 collapses to the editor as text; sending runs it as one line (newlines become `;`-less raw — document as known limitation until the multiline slice). Bracketed-paste handling deferred.
- **Broadcast (MultiExec) mode:** Enter routes through the broadcast-aware send so the line still fans out.
- **Focus slips** (user clicks into xterm): clicking the terminal area while atPrompt refocuses the editor; the editor is the single source of truth for prompt input.
- **Resize / font-zoom / scroll:** reposition overlay; recompute cell metrics.
- **SSH / remote shells:** work if Pluto's integration (and thus `133;B`) is installed in the remote shell; otherwise no `B` → passthrough (unchanged).
- **Restored scrollback:** the existing `restoringScrollback` guard already suppresses replayed markers; `B` handler respects it too.
- **Feature off:** when `st.promptEditor` is false, none of this mounts — byte-for-byte today's behavior.

## Testing

- Manual (dev loop) is primary: toggle on, verify highlight + Enter-send + ↑/↓ history on PowerShell 7; verify vim/less/ssh-password/python-REPL all pass through cleanly; verify resize reposition; verify off = unchanged.
- Unit-testable seam: the shell tokenizer/highlight config and the prompt-state machine (`promptState.js`) are pure and can take lightweight tests.

## Out of scope (later slices)

Multiline + soft-wrap + click-to-place; ghost-text autosuggest (route PSReadLine predictions or app history into a CM inline hint); inline fuzzy tab-completions menu (bridge to PSReadLine / a completion source); Vim mode.

## Risks

- Precise overlay positioning across powerline/wide-glyph prompts — mitigated by anchoring on the `133;B` cursor position rather than parsing the prompt.
- Alt-screen detection timing — mitigated by reacting to buffer-type change events, with passthrough as the safe default.
- xterm internals for cell metrics are semi-private — wrap in try/catch with a measured fallback.
- Opt-in default-off contains all of the above to users who choose to test.
