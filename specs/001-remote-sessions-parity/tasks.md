<!-- (C) -->
---
description: "Task list for Unified Remote Sessions — first-class RDP & VNC"
---

# Tasks: Unified Remote Sessions — First-Class RDP & VNC

**Input**: Design documents from `specs/001-remote-sessions-parity/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui-contracts.md, quickstart.md

**Tests**: No automated UI test harness exists in-repo; verification is **manual / live** per
Constitution Principle II. Test tasks are therefore live-verification tasks (screenshot the
running app), not unit tests.

**Organization**: Grouped by user story (P1 → P2 → P3) for independent, incremental delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: US1 / US2 / US3
- All paths are under `src/features/terminals/` unless noted.

---

## Phase 1: Setup

**Purpose**: Confirm a clean baseline before touching code.

- [ ] T001 Launch the app on branch `001-remote-sessions-parity` (`npm run tauri dev`), confirm it renders, and screenshot the running window as the pre-change baseline (Principle II).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared state/launch plumbing every user story depends on.

**⚠️ CRITICAL**: Complete before any user story.

- [X] T002 Add an in-memory per-session password cache with helpers `rememberSessionPassword(sessionId, secret)`, `getSessionPassword(sessionId)`, `forgetSessionPassword(sessionId)` in `TerminalsTab.jsx` (app-run lifetime, never persisted) — contract C3, FR-008.
- [X] T003 Add a focus-existing-tab lookup (`focusExistingProjectTab`) used by `openProjectInPanel` in `TerminalsTab.jsx` — contract C2 step 1, FR-012. (Scoped to the RDP/VNC launch branches, where duplicate connections are costly; local/SSH keep multi-tab behavior.)

**Checkpoint**: Shared launch/credential plumbing ready.

---

## Phase 3: User Story 1 — Save and reconnect a remote desktop (Priority: P1) 🎯 MVP

**Goal**: Create, save, and one-click-reconnect RDP/VNC sessions from the sidebar; they persist across restart.

**Independent Test**: Add a VNC and an RDP session, save, restart the app, click each → tab opens and begins connecting; sessions still listed.

- [X] T004 [P] [US1] Add `rdp` and `vnc` type tabs to the type selector, their form fields (RDP: host/port[3389]/username/domain; VNC: host/port[5900]), `canSave` rules (name + host), and `onSave` payloads in `ProjectDialog.jsx` — contract C1, FR-001/FR-002.
- [X] T005 [US1] Extend `openProjectInPanel` in `TerminalsTab.jsx` with `type === "vnc"` and `type === "rdp"` branches: build the tab (`vnc`/`rdp` field + `projectId`), resolve the password (session cache → else prompt), abort cleanly on cancel, then `spawnSessionTab` — contract C2, FR-004 (depends on T002, T003).
- [X] T006 [US1] Wire the saved-session password prompt for rdp/vnc launch by reusing `RdpConnectModal`/`VncConnectModal` pre-filled + locked on the saved host/port (`launchVnc`/`launchRdp`), feeding the secret into the session cache + tab bridge in `TerminalsTab.jsx` (depends on T005).
- [X] T007 [P] [US1] Add `rdp`/`vnc` type→icon mapping in the sidebar rows (`osIconFor` already maps rdp/vnc → Windows icon) in `ProjectSidebar.jsx` — contract C7, FR-007.
- [X] T008 [P] [US1] Add `rdp`/`vnc` type→icon mapping (RDP 🪟, VNC 🖱) in the saved-session grid in `MobaHomeScreen.jsx` — contract C4.
- [ ] T009 [US1] Verify live (Principle II): create+save a VNC and an RDP session, launch each (connection attempt visible), quit+relaunch → both still listed with name/color/folder; screenshot each ✅ in quickstart US1 (depends on T004–T008). **PENDING live run.**

**Checkpoint**: RDP/VNC are saveable + one-click launchable + durable — MVP usable.

---

## Phase 4: User Story 2 — Organize and edit saved remote desktops (Priority: P2)

**Goal**: Full lifecycle parity — edit, rename, color, folder, delete, unified search, forget-password.

**Independent Test**: Edit a saved RDP/VNC session's details, color, folder; search across types; delete; confirm persistence.

- [X] T010 [US2] Populate rdp/vnc fields in `ProjectDialog` edit mode (init state from `initial.rdp`/`initial.vnc` in the open effect; `sessionType()` already returns stored `type`) in `ProjectDialog.jsx` — FR-005.
- [X] T011 [P] [US2] Include rdp/vnc `host` in the unified sidebar search filter in `ProjectSidebar.jsx` so SSH/RDP/VNC match together — FR-007.
- [X] T012 [P] [US2] Wire the "forget password" context-menu action for rdp/vnc sessions to `forgetSessionPassword` in `ProjectSidebar.jsx` + `TerminalsTab.jsx` — FR-008.
- [ ] T013 [US2] Verify live: edit host/port, set color+folder, search across all three types, delete a session; relaunch → changes persisted; screenshot quickstart US2 (depends on T010–T012). **PENDING live run.**

**Checkpoint**: RDP/VNC have full SSH-parity lifecycle.

---

## Phase 5: User Story 3 — Verify the remote-session story works live (Priority: P3)

**Goal**: Robust failure UX + quick-connect promotion, then end-to-end live verification.

**Independent Test**: Drive SSH against the VPS end-to-end; drive RDP/VNC UI flow incl. error/retry, cancel, reconnect, focus-existing.

- [X] T014 [P] [US3] Add an inline error state + **Retry** button to `VncView.jsx` (transition on `vnc-exit`/connect failure; Retry re-invokes connect via `retryKey`) — contract C6, FR-009.
- [X] T015 [P] [US3] Add an inline error state + **Retry** button to `RdpView.jsx` (transition on `rdp-exit`/connect failure; Retry re-invokes connect via `retryKey`) — contract C6, FR-009.
- [X] T016 [P] [US3] Add a "Save this connection" affordance + `onSaveSession`/`initial`/`lockConnection` to `VncConnectModal.jsx` — contract C5, FR-013.
- [X] T017 [P] [US3] Add a "Save this connection" affordance + `onSaveSession`/`initial`/`lockConnection` to `RdpConnectModal.jsx` — contract C5, FR-013.
- [X] T018 [US3] Wire `onSaveSession` (`saveQuickConnection`) from both connect modals to append a saved session (no password) to `state.projects` in `TerminalsTab.jsx` — FR-013 (depends on T016, T017).
- [ ] T019 [US3] Live SSH verification vs the VPS: save session, connect, interactive shell, SFTP browse, disconnect + reconnect without restart; screenshots — quickstart US3/SSH, SC-004. **PENDING live run (needs VPS).**
- [ ] T020 [US3] RDP/VNC UI-flow verification: launch; point at an unreachable host → inline error + Retry (T014/T015); cancel password prompt → clean abort; same-run reconnect skips prompt (T002); click already-open session → focuses existing tab (T003); screenshots — quickstart US3/RDP-VNC. **PENDING live run.**
- [ ] T021 [US3] Credential safety check: confirm no plaintext remote-session password in localStorage (`state.projects`) or under `data/` — FR-008, SC-005. (Design-verified: saved records never include a password; secrets live only in `ptyBridge` + `sessionPwRef` in-memory. **Runtime confirmation PENDING live run.**)
- [X] T022 [US3] Record the **[DEFERRED]** live RDP/VNC connection tests (US3 #5) as outstanding — captured in spec.md (US3 #5 `[DEFERRED]`) and quickstart.md (Deferred section). Not marked complete by proxy.

**Checkpoint**: Story verified live where servers exist; deferred items explicitly tracked.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T023 [P] Ensure the `(C)` marker is present on every created/modified file in `src/features/terminals/` — Principle III. (Added to TerminalsTab/ProjectSidebar/ProjectDialog; siblings already had it.)
- [ ] T024 [P] MobaXterm v12.4 **dark** fidelity pass on the new RDP/VNC dialog tabs + modal affordances; side-by-side screenshot compare — FR-010, SC-006. (New UI reuses existing `--phn-*` dark tokens; **visual confirmation PENDING live run.**)
- [ ] T025 Run the full `quickstart.md` end-to-end and capture the screenshot set as the completion evidence — Principle II. **PENDING live run.**

> **Implementation status (2026-05-29):** All code tasks complete; frontend `npm run build` green. No backend changes. The remaining unchecked tasks (T001, T009, T013, T019–T021, T024, T025) are **live-verification gates** that require running the app (and, for T019, the VPS) — they are intentionally NOT checked off until observed in the running app per Principle II.

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → **Phase 2 (Foundational)** blocks all stories.
- **US1 (P3)** depends on Foundational (T002, T003). It is the MVP.
- **US2 (P4)** depends on Foundational; builds on US1's dialog but is independently testable.
- **US3 (P5)** depends on Foundational; T014–T018 are feature work, T019–T022 are verification.
- **Polish (P6)** after the desired stories.

### Within stories

- US1: T004 (dialog) ∥ T007/T008 (icons) can run parallel; T005 needs T002/T003; T006 needs T005; T009 verifies after all.
- US3: T014/T015/T016/T017 are parallel (different files); T018 needs T016/T017.

## Parallel Opportunities

- US1: `[P]` T004, T007, T008 together (ProjectDialog, ProjectSidebar, MobaHomeScreen — distinct files).
- US3: `[P]` T014, T015, T016, T017 together (VncView, RdpView, VncConnectModal, RdpConnectModal — distinct files).
- Polish: `[P]` T023, T024 together.

## Implementation Strategy

### MVP first (US1 only)
1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & VALIDATE** (T009) → demo.

### Incremental delivery
US1 (saveable+launchable+durable) → US2 (organize/edit) → US3 (robust failure UX + live verify). Each adds value without breaking the prior.

## Notes

- `[P]` = different files, no incomplete deps. Commit after each task or logical group.
- No backend (`src-tauri/`) changes expected — transports already exist.
- Live verification tasks are gates, not formalities (Principle II). Green build ≠ done.
- The deferred live RDP/VNC connection test stays outstanding until test servers exist (T022).

**Total tasks**: 25 — Setup 1, Foundational 2, US1 6, US2 4, US3 9, Polish 3.
