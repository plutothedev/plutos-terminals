<!-- (C) -->
# Phase 0 Research: Unified Remote Sessions

No external/unknown technologies — all transports and views already exist. Research here
resolves *how to extend the existing patterns* rather than evaluating new tech.

## R1 — How are saved sessions modeled and persisted today?

**Decision**: Reuse `state.projects` (array of session records) with a `type` discriminator;
add `"rdp"` and `"vnc"` alongside `"local"` and `"ssh"`. Persistence is automatic via the
App-level localStorage `{ st, save }` wrapper — no new storage layer.

**Rationale**: `ProjectDialog` already branches on `type` (`local` | `ssh`), and
`sessionType(initial)` already defaults legacy records. Adding two more enum values is the
minimal, consistent change. Color, folder, tags, rename, delete, and search in
`ProjectSidebar` are already type-agnostic (keyed off generic record fields), so RDP/VNC get
those behaviors for free.

**Alternatives considered**: A separate "connections" store for remote desktops — rejected;
it would duplicate the sidebar's folder/search/color machinery and break unified search
(FR-007).

## R2 — How does a saved session become a tab?

**Decision**: Extend the single launch path `openProjectInPanel(panelId, projectId)` in
`TerminalsTab.jsx`. Add branches: `type === "vnc"` → create a tab `{ vnc: { host, port } }`;
`type === "rdp"` → `{ rdp: { host, port, username, domain } }`. `TerminalPanel.jsx` already
renders `<VncView>` / `<RdpView>` when those fields are present.

**Rationale**: There is exactly one launch path used by the sidebar click, the home-screen
saved-session grid, and drag-drop. Extending it covers all entry points at once.

**Alternatives considered**: New separate launch functions per type — rejected; would
fragment the entry points and duplicate the focus-existing and password logic.

## R3 — Focus-existing-tab behavior (FR-012)

**Decision**: Before creating a new tab in `openProjectInPanel`, scan open tabs across panels
for one whose `projectId === projectId`. If found, activate its panel + tab instead of
opening a second connection.

**Rationale**: Matches the clarified decision; avoids duplicate RDP/VNC connections (which
consume a worker thread + socket each). Keyed on `projectId`, which saved-session tabs already
carry.

**Alternatives considered**: Dedup by host:port — rejected; two differently-named saved
sessions to the same host should remain distinct.

## R4 — Transient password handling + "remember for session" + forget (FR-008)

**Decision**: Mirror the SSH pattern. SSH uses `setTabPassword(tabId, secret)` (in-memory
`ptyBridge`) read at spawn time, with optional keychain save via `secret_set` and a
"forget" action (`onForgetPassword`). For RDP/VNC: prompt on first launch, hold the secret
in an **in-memory per-session cache** keyed by session id so same-run reconnects skip the
prompt; expose a "forget" action in the sidebar context menu. Do NOT auto-persist RDP/VNC
secrets to keychain in this phase (clarified scope: in-memory for the session).

**Rationale**: Honors the clarification (in-memory, with forget; never on disk) while reusing
the existing transient-bridge concept. Keychain save for RDP/VNC is a natural later
extension but is out of scope now to keep parity decisions explicit.

**Alternatives considered**: Immediate keychain save for parity with SSH — rejected for this
phase per the clarification; revisit later if the user wants it.

## R5 — Inline error + Retry (FR-009)

**Decision**: `VncView.jsx` / `RdpView.jsx` already listen for `vnc-exit` / `rdp-exit`
events. Add an error/disconnected overlay state to each that shows the failure reason and a
**Retry** button that re-invokes the connect path with the same params. A cancelled password
prompt aborts before any connect call (no orphaned worker).

**Rationale**: Keeps error UX inside the tab where the user is looking; reuses the existing
exit-event channel as the failure signal.

**Alternatives considered**: Global toast only — rejected; loses the in-context retry
affordance the clarification chose.

## R6 — Keep quick-connect + "Save this connection" (FR-013)

**Decision**: Leave the home-screen quick-connect cards and the `VncConnectModal` /
`RdpConnectModal` ephemeral flow intact. Add a "Save this connection" affordance to each
modal that, on use, creates a saved session record (same payload shape `ProjectDialog`
produces) and adds it to `state.projects`.

**Rationale**: Honors the clarified "keep both paths" decision; one-offs stay fast, and a
good one-off can be promoted to a saved session without retyping.

**Alternatives considered**: Replace quick-connect entirely — rejected by clarification.

## R7 — Icon / type affordances in sidebar + home grid

**Decision**: Extend `ProjectSidebar.jsx` and `MobaHomeScreen.jsx` type→icon mapping: VNC →
🖱 (or screen icon), RDP → 🪟, matching the existing quick-connect card icons; SSH stays 🌐,
local 🖥. Ensure unified search (FR-007) treats host fields of all remote types.

**Rationale**: Visual distinguishability (FR-007) with icons already established in
`MobaHomeScreen` QUICK cards for consistency.

## Open questions

None remaining — all spec `[NEEDS CLARIFICATION]` were resolved in the clarify session; the
only deferred item is the live RDP/VNC connection test (US3 #5), which is a test-environment
dependency, not a design unknown.
