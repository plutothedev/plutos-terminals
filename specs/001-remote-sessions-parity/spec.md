<!-- (C) -->
# Feature Specification: Unified Remote Sessions — First-Class RDP & VNC

**Feature Branch**: `001-remote-sessions-parity`

**Created**: 2026-05-29

**Status**: Draft

**Input**: User description: "MobaXterm-style left session sidebar, tabbed RDP and VNC remote desktop panels embedded in the grid, and a real SSH tab — verified against a live VPS. Scope refined to: RDP/VNC already render and connect but are ephemeral; make them first-class saved sessions on par with SSH, then verify the whole remote-session story live."

## Overview

Pluto's Terminals already has a MobaXterm-style left session sidebar, real SSH sessions
(saveable, editable, reconnectable), and working RDP and VNC remote-desktop panels that
render as tabs in the grid. The gap: **RDP and VNC connections are ephemeral** — they can
only be launched from the home-screen quick cards, and cannot be saved, named, organized,
edited, or reconnected from the sidebar the way SSH sessions can.

This feature closes that parity gap so RDP and VNC are first-class saved sessions, and then
verifies the end-to-end remote-session experience against a real server. Live SSH
verification runs against the user's Linux VPS now; live RDP/VNC connection verification is
explicitly deferred until a test RDP/VNC server is available (see deferred acceptance
criteria) and must not be silently skipped.

## Clarifications

### Session 2026-05-29

- Q: When a user clicks a saved remote session that already has an open tab, what should happen? → A: Focus the existing tab instead of opening a second connection.
- Q: How should a failed remote connection (unreachable host, auth failure) appear? → A: Inline error state in the tab with a Retry button.
- Q: What happens to the ephemeral home-screen quick-connect cards once sessions are saveable? → A: Keep both paths; add a "Save this connection" affordance to the quick-connect modal.
- Q: How should RDP/VNC passwords behave across reconnects within one app run? → A: Remember in-memory for the session (with a "forget" option); never written to disk. Matches existing SSH behavior.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Save and reconnect a remote desktop session (Priority: P1)

A user who regularly connects to the same RDP or VNC host wants to save that connection in
the left sidebar so they can reconnect with a single click instead of re-typing host/port
every time — exactly as they already do for SSH.

**Why this priority**: This is the core new value of the feature. Without it, RDP/VNC remain
second-class. With just this story shipped, a user gets durable, click-to-reconnect remote
desktops — a viable MVP on its own.

**Independent Test**: Create a new RDP (or VNC) session via the sidebar's add flow, give it a
name and host/port, save it, restart the app, and confirm the session is still listed and a
single click opens its remote-desktop tab and begins connecting.

**Acceptance Scenarios**:

1. **Given** the session sidebar is open, **When** the user adds a new session and chooses
   the RDP type, enters a name + host + port (+ username/domain), and saves, **Then** the
   session appears in the sidebar with the correct remote-desktop icon and saved name.
2. **Given** a saved RDP session, **When** the user clicks it, **Then** a remote-desktop tab
   opens in the active panel and begins connecting, prompting for the password (which is
   never stored).
3. **Given** a saved VNC session, **When** the user clicks it, **Then** a VNC tab opens in
   the active panel and begins connecting, prompting for the password.
4. **Given** the app is closed and reopened, **When** the sidebar loads, **Then** all
   previously saved RDP and VNC sessions are still present with their names, colors, and
   folders intact.

---

### User Story 2 - Organize and edit saved remote desktop sessions (Priority: P2)

A user with several saved remote sessions wants to rename them, assign colors, group them
into folders, edit their connection details, and delete them — the same lifecycle SSH
sessions already support.

**Why this priority**: Completes true parity with SSH and makes a growing list of remote
hosts manageable. Valuable but not required for the first usable slice (P1).

**Independent Test**: Take an existing saved RDP/VNC session, edit its host/port, rename it,
assign a color and folder, then delete it — confirming each change persists and is reflected
in the sidebar.

**Acceptance Scenarios**:

1. **Given** a saved RDP/VNC session, **When** the user opens its edit dialog and changes the
   host/port/username, **Then** the changes persist and the next launch uses the new details.
2. **Given** a saved RDP/VNC session, **When** the user assigns a color and a folder, **Then**
   the session shows that color and appears grouped under that folder in the sidebar.
3. **Given** a saved RDP/VNC session, **When** the user deletes it, **Then** it is removed
   from the sidebar and does not reappear after restart.
4. **Given** saved SSH, RDP, and VNC sessions in the same folder, **When** the user searches
   by name or host, **Then** matching sessions of all three types are returned together.

---

### User Story 3 - Verify the remote-session story works live (Priority: P3)

The user (acting as tester) wants confidence that the remote-session experience actually
works against a real server, not just that the code compiles.

**Why this priority**: Per project Principle II, a green build is not evidence the app
renders or connects. This story is the verification gate before the feature is considered
done. It depends on P1 (and ideally P2) being in place.

**Independent Test**: Using the live VPS, drive the full SSH lifecycle through the UI and
observe the running app; for RDP/VNC, drive the save/edit/launch UI flow and observe the
connection attempt.

**Acceptance Scenarios**:

1. **Given** a saved SSH session pointing at the live VPS, **When** the user clicks it,
   **Then** an interactive shell opens, accepts input, and shows command output in the
   running app (screenshot-confirmed).
2. **Given** a connected SSH session, **When** the user opens the SFTP browser, **Then**
   remote files list and basic navigation works.
3. **Given** a connected SSH session, **When** the user disconnects and clicks the saved
   session again, **Then** it reconnects cleanly without app restart.
4. **Given** the parity UI from P1/P2, **When** the user creates, saves, edits, and launches
   an RDP and a VNC session, **Then** the UI flow renders correctly and a connection attempt
   is initiated (observed in the running app).
5. **[DEFERRED]** **Given** a reachable RDP server and a reachable VNC server, **When** the
   user launches the corresponding saved sessions, **Then** the remote desktop renders and
   accepts mouse/keyboard input. This criterion is explicitly deferred until the user stands
   up test RDP/VNC servers and MUST be tracked as outstanding, not marked complete by proxy.

---

### Edge Cases

- What happens when a saved remote session's host is unreachable or the port is closed? The
  tab must surface a clear connection error rather than hanging silently or blanking.
- What happens when the user cancels the password prompt for an RDP/VNC launch? The launch
  must abort cleanly with no orphaned connection.
- What happens to a saved RDP/VNC session if its connection details are incomplete (e.g.
  missing host)? Saving must be prevented or the session clearly flagged as invalid.
- How does the system handle launching the same saved session twice? It focuses the existing
  open tab rather than opening a second connection (FR-012).
- What happens to a saved session's color/folder when its folder is deleted or renamed? It
  must degrade gracefully (e.g. fall back to ungrouped), not vanish.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to create and save an RDP session in the sidebar, capturing
  at least name, host, port, username, and (optional) domain.
- **FR-002**: Users MUST be able to create and save a VNC session in the sidebar, capturing
  at least name, host, and port.
- **FR-003**: Saved RDP and VNC sessions MUST persist across app restarts, including name,
  color, and folder assignment.
- **FR-004**: Users MUST be able to launch a saved RDP/VNC session with a single click,
  opening its remote-desktop tab in the active panel.
- **FR-005**: Users MUST be able to edit a saved RDP/VNC session's connection details, name,
  color, and folder.
- **FR-006**: Users MUST be able to delete a saved RDP/VNC session.
- **FR-007**: Saved RDP, VNC, and SSH sessions MUST coexist in the same sidebar, be visually
  distinguishable by type icon, and be searchable together by name/host/folder.
- **FR-008**: Passwords for RDP/VNC sessions MUST NOT be written to disk. They MUST be
  prompted at launch, then held in-memory for the duration of the app run so reconnects to
  the same session do not re-prompt; the user MUST be able to "forget" a remembered password.
  This matches the existing SSH transient-credential behavior.
- **FR-009**: Launch failures (unreachable host, auth failure) MUST surface a clear, inline
  error state within the tab that includes a Retry action; a cancelled password prompt MUST
  abort the launch cleanly with no orphaned connection.
- **FR-012**: Clicking a saved session that already has an open tab MUST focus that existing
  tab rather than opening a second connection.
- **FR-013**: The ephemeral home-screen quick-connect cards for RDP/VNC MUST be retained for
  one-off connections, AND the quick-connect modal MUST offer a "Save this connection"
  affordance that creates a saved sidebar session from the entered details.
- **FR-010**: New and modified sidebar/dialog UI MUST visually match the MobaXterm v12.4 dark
  reference (Principle IV).
- **FR-011**: The feature MUST be verified in the running app via screenshots of live
  behavior before being marked complete (Principle II); the SSH path MUST be verified against
  the live VPS, and the deferred RDP/VNC live-connection verification MUST be recorded as
  outstanding.

### Key Entities *(include if feature involves data)*

- **Saved Session**: A persisted connection the user can reconnect to. Common attributes:
  id, name, type (ssh | rdp | vnc | local), color, folder, tags. Type-specific connection
  details:
  - **SSH**: host, port, user, auth method (password/key/agent), proxy-jump (existing).
  - **RDP**: host, port, username, domain.
  - **VNC**: host, port.
  - Passwords are NOT part of the persisted entity.
- **Session Folder**: A named grouping in the sidebar that contains zero or more saved
  sessions of any type.
- **Remote Desktop Tab**: A grid tab whose content is a remote-desktop canvas (RDP or VNC)
  rather than a terminal; full-tab (not split-pane) for this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can save a new RDP or VNC connection and reconnect to it in a single
  click, with zero re-entry of host/port, on a fresh app launch.
- **SC-002**: 100% of saved remote sessions (SSH, RDP, VNC) survive an app restart with name,
  color, and folder intact.
- **SC-003**: A user can go from "no saved remote desktop" to "connected (or connection
  attempted) remote desktop tab" in under 60 seconds, excluding password entry.
- **SC-004**: SSH against the live VPS is confirmed end-to-end (connect, interactive shell,
  SFTP, reconnect) with screenshot evidence from the running app.
- **SC-005**: Zero passwords for any remote session type are found persisted to disk after
  saving and launching sessions.
- **SC-006**: New sidebar/dialog UI is judged a visual match to the MobaXterm v12.4 dark
  reference on side-by-side comparison.

## Assumptions

- The existing SSH, RDP, and VNC transports work as built; this feature does not rebuild
  them (out of scope).
- RDP/VNC remain full-tab remote desktops; embedding them inside split panes is out of scope.
- The user's live VPS is reachable over SSH and is the live test surface for this phase; no
  RDP or VNC server is available yet, so live RDP/VNC connection verification is deferred.
- The sidebar's existing persistence mechanism for SSH/local sessions can be extended to
  carry RDP/VNC session records (no new external storage system is required).
- Password handling follows the existing transient-credential pattern already used for SSH.

## Out of Scope

- Rebuilding or modifying the underlying SSH/RDP/VNC transport.
- Persisting any remote-session passwords.
- RDP/VNC inside split panes (they stay full-tab).
- A connection-history / last-used-host autofill feature (could be a later phase).
