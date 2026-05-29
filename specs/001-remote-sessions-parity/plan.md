<!-- (C) -->
# Implementation Plan: Unified Remote Sessions — First-Class RDP & VNC

**Branch**: `001-remote-sessions-parity` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-remote-sessions-parity/spec.md`

## Summary

Make RDP and VNC connections first-class **saved sessions** in the existing left session
sidebar, on par with SSH, then verify the whole remote-session story live (SSH against the
user's VPS now; RDP/VNC live-connect deferred). The transports (`ssh2`, `ironrdp`, `vnc`
crate) and the canvas views (`RdpView.jsx`, `VncView.jsx`) already exist and work. The work
is almost entirely in the React layer: extend the saved-session data model with `rdp`/`vnc`
types, add those types to `ProjectDialog`, teach the single launch path
(`openProjectInPanel`) to open a remote-desktop tab for them, keep the ephemeral
quick-connect modals but add a "Save this connection" affordance, add focus-existing-tab and
inline-error-with-retry behavior, and mirror the SSH transient-password pattern.

## Technical Context

**Language/Version**: JavaScript (React 18, Vite) frontend; Rust 2021 (Tauri 2.10) backend

**Primary Dependencies**: Tauri 2, xterm.js; backend transports already present — `ssh2`
(vendored-openssl), `ironrdp`/`ironrdp-blocking`, `vnc` crate. No new dependencies expected.

**Storage**: Saved sessions persist in `state.projects` via the App-level localStorage
`{ st, save }` wrapper. Optional secrets use the OS keychain (`vault.rs` →
`secret_get`/`secret_set`). Transient launch passwords live in-memory in `ptyBridge`.

**Testing**: Manual live verification against the running app (Principle II) + `cargo build`
/ `npm run build` for compile gates. No automated UI test harness exists in-repo.

**Target Platform**: Desktop (macOS arm64 primary dev target; Windows secondary). WKWebView
on macOS.

**Project Type**: Desktop app (Tauri + React single frontend).

**Performance Goals**: UI interactions feel instant (<100ms to open a tab); remote-desktop
frame rendering unchanged from current behavior (out of scope to optimize).

**Constraints**: No passwords written to disk in plaintext (keychain is acceptable secure
storage); no WebGL renderer; keep `vendored-openssl`. New UI must match MobaXterm v12.4 dark.

**Scale/Scope**: Single user, tens of saved sessions. Scope is ~5 frontend files + 2 modal
files; no backend changes anticipated.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. v0-First Discipline | ✅ PASS (justified) | This does NOT start a named v1 feature (agent grid, prompt-pack loader, MCP installer). It hardens and unifies remote-session capability already present on the Pro-overhaul branch — parity + verification, not new deferred scope. |
| II. Verify Live After Each Phase | ✅ PASS | Plan mandates running the app + screenshots; SSH verified against the live VPS; RDP/VNC live-connect explicitly deferred and tracked. |
| III. Authorship Marker | ✅ PASS | All Claude-authored/modified files carry the `(C)` marker. |
| IV. MobaXterm v12.4 Dark Fidelity | ✅ PASS | New dialog/sidebar UI reuses existing `--phn-*` dark tokens; screenshot-compared to reference. |
| V. Brain/Operations Boundary | ✅ PASS | No writes to the vault; session records stay in localStorage, secrets in keychain. |
| VI. Lyfe Cherry-Pick vs Diverge | ✅ PASS | UX change → diverge (own design); no Lyfe code lifted here. |
| VII. Renderer & Build Constraints | ✅ PASS | No renderer change; no OpenSSL linkage change; no backend transport change. |

No violations → no Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/001-remote-sessions-parity/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output (manual verification runbook)
├── contracts/
│   └── ui-contracts.md  # Phase 1 output (session record shape, api methods, tab shapes)
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

```text
src/features/terminals/
├── ProjectDialog.jsx      # ADD rdp/vnc type tabs + their form fields + save payloads
├── ProjectSidebar.jsx     # ADD rdp/vnc type detection → icons; (color/folder/edit/delete already generic)
├── MobaHomeScreen.jsx     # EXTEND saved-session icon mapping to rdp/vnc
├── TerminalsTab.jsx       # EXTEND openProjectInPanel (rdp/vnc launch + focus-existing);
│                          #   add per-session transient password cache + forget for rdp/vnc;
│                          #   wire "Save this connection" from the quick-connect modals
├── VncConnectModal.jsx    # ADD "Save this connection" affordance
├── RdpConnectModal.jsx    # ADD "Save this connection" affordance
├── VncView.jsx            # ADD inline error state + Retry (FR-009)
└── RdpView.jsx            # ADD inline error state + Retry (FR-009)

src-tauri/
└── (no changes expected — transports already exist)
```

**Structure Decision**: Single React frontend feature; all changes are localized to
`src/features/terminals/`. No new modules, no backend changes. This keeps the diff small and
reviewable and leans entirely on existing, proven patterns (the SSH saved-session lifecycle).

## Complexity Tracking

No constitution violations; section intentionally empty.
