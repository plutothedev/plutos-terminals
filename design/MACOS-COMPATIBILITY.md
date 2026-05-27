# macOS Compatibility — Pluto's Terminals

> **Status:** Mostly ready. Three small changes unlock macOS builds.
> **Effort:** ~15 minutes of edits + one `cargo tauri build` on a Mac.

---

## What's Already Cross-Platform ✅

| Component | Status | Notes |
|-----------|--------|-------|
| **PTY backend** | ✅ | `portable-pty` uses Unix PTYs on macOS automatically. `pty.rs` has `#[cfg(not(target_os = "windows"))]` → reads `$SHELL` or falls back to `/bin/bash`. |
| **Tauri v2 tray/menu** | ✅ | `lib.rs` uses Tauri v2 `TrayIconBuilder` + `MenuItem` — cross-platform. macOS shows tray icon in the menu bar. |
| **Data directory** | ✅ | `commands.rs` uses `app.path().app_local_data_dir()` — Tauri handles macOS `~/Library/Application Support/com.plutothedev.terminals/`. |
| **Icons** | ✅ | `icon.icns` already exists in `src-tauri/icons/` and is referenced in `tauri.conf.json`. |
| **Window spawn** | ✅ | `spawn_new_window` uses Tauri APIs — no platform-specific code. |
| **State persistence** | ✅ | `localStorage` + Tauri filesystem commands are platform-agnostic. |

---

## What Needs to Change — 3 Items

### 1. Add macOS Bundle Targets

**File:** `src-tauri/tauri.conf.json`

**Current:**
```json
"targets": ["msi"]
```

**Change to:**
```json
"targets": ["msi", "dmg", "app"]
```

This tells Tauri to build:
- `.msi` for Windows (existing)
- `.dmg` for macOS (disk image installer)
- `.app` for macOS (standalone app bundle)

**Optional:** Add mac-specific entitlements if you plan to notarize later:
```json
"macOS": {
  "frameworks": [],
  "minimumSystemVersion": "10.13",
  "signingIdentity": null,
  "entitlements": null
}
```

---

### 2. Fix MCP Installer Home-Path Expansion

**File:** `src/components/McpInstaller.jsx` (line 83)

**Current (Windows-only):**
```javascript
let cmd = mcp.command.replace(/\$\{PWD\}/g, "%USERPROFILE%");
```

**Problem:** On macOS, `%USERPROFILE%` is not a valid env var. The Filesystem MCP install command will fail because it tries to use a Windows env var in a Unix shell.

**Fix — detect platform:**
```javascript
const isWindows = navigator.userAgent.includes("Windows");
const homeVar = isWindows ? "%USERPROFILE%" : "$HOME";
let cmd = mcp.command.replace(/\$\{PWD\}/g, homeVar);
```

This keeps Windows behavior unchanged and uses `$HOME` on macOS (and Linux).

---

### 3. Update Prompt-Pack Docs to Mention Cross-Platform Vars

**Files:**
- `prompt-packs/README.md` (line 122)
- `prompt-packs/HOW_TO_USE.md` (lines 66, 72, 76)
- `prompt-packs/example.deck.json` (line 39)

**Current docs** say `${USERPROFILE}` is "Windows home directory."

**Update to:**
```markdown
- `${USERPROFILE}` — Windows home directory
- `${HOME}` — macOS / Linux home directory
```

The **Rust backend already expands any env var** — `${HOME}` works on macOS today. The docs just don't mention it.

---

## Build Steps on Your MacBook

1. **Install prerequisites:**
   ```bash
   # Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env

   # Node + npm (use n or fnm)
   npm install -g pnpm   # or npm
   ```

2. **Clone the repo:**
   ```bash
   cd ~
   git clone https://github.com/plutothedev/plutos-terminals.git
   cd plutos-terminals
   ```

3. **Install deps:**
   ```bash
   npm install
   ```

4. **Dev mode (fastest first-run check):**
   ```bash
   npm run tauri dev
   ```
   First Rust compile takes ~2–3 minutes. The app window should open with a local shell (`$SHELL`, usually `/bin/zsh` on macOS).

5. **Production build (creates `.dmg` + `.app`):**
   ```bash
   npm run tauri build
   ```
   Output lands in:
   ```
   src-tauri/target/release/bundle/dmg/Plutos_Terminals_0.1.32_aarch64.dmg
   src-tauri/target/release/bundle/macos/Pluto's Terminals.app
   ```

6. **GitHub Release:**
   Upload the `.dmg` to a GitHub release (same workflow as the existing `.msi`).

---

## Known macOS Quirks

| Quirk | Impact | Fix |
|-------|--------|-----|
| **Notarization** | Gatekeeper blocks unsigned apps by default. | Right-click → Open, or `xattr -cr "/Applications/Pluto's Terminals.app"`. For distribution, sign with Apple Developer cert ($99/yr). |
| **Menu bar vs. system tray** | macOS shows tray in the top menu bar, not the dock. | Already handled by Tauri v2. "Quit" tray item fully exits the app. |
| **Shell default** | macOS default `$SHELL` is `/bin/zsh` (Catalina+). | Already handled by `pty.rs` fallback. Users can change via `chsh` if they want bash/fish. |
| **Key combos** | `Ctrl+K` may conflict with macOS text editing. | Test `Ctrl+K` in the app. If it deletes-to-end-of-line (macOS default), remap to `Cmd+K` or `Ctrl+Shift+K` for the command palette. |
| **Window decorations** | macOS has traffic-light buttons (close/minimize/zoom) on the left. | Tauri handles this natively. `decorations: true` in `tauri.conf.json` shows native chrome. |

---

## Files Modified for macOS (Summary)

| File | Change |
|------|--------|
| `src-tauri/tauri.conf.json` | Add `"dmg"`, `"app"` to bundle targets |
| `src/components/McpInstaller.jsx` | Platform-aware `${PWD}` → `%USERPROFILE%` or `$HOME` |
| `prompt-packs/README.md` | Mention `${HOME}` for macOS/Linux |
| `prompt-packs/HOW_TO_USE.md` | Mention `${HOME}` for macOS/Linux |
| `prompt-packs/example.deck.json` | Mention `${HOME}` for macOS/Linux |

---

## Quick Test Checklist

- [ ] `npm run tauri dev` boots on Mac with `/bin/zsh` shell
- [ ] Typing in terminal works (PTY → xterm.js roundtrip)
- [ ] New tab spawns a new zsh session
- [ ] Split panel works
- [ ] Tray icon appears in menu bar
- [ ] Hide → Show from tray works
- [ ] Quit from tray fully exits
- [ ] Scrollback persists across tab switches
- [ ] Themes switch correctly
- [ ] `npm run tauri build` produces `.dmg`
- [ ] `.dmg` mounts and installs to `/Applications`
- [ ] App launches from `/Applications`

---

*This doc should be attached to the reskin prompt so Claude Code handles macOS compatibility alongside the UI reskin.*
