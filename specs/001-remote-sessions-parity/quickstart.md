<!-- (C) -->
# Quickstart / Verification Runbook: Unified Remote Sessions

Per Constitution Principle II, a green build is not done. This runbook is the live
verification gate. Run the app and screenshot each ✅ step.

## Launch

```bash
npm install        # if deps changed
npm run tauri dev  # arm64 macOS dev build
```

Filter the screenshot to the **Pluto's Terminals** window (OWNER plutos-terminals).

## US1 — Save & reconnect a remote desktop (P1)

1. Open the session sidebar → "+" (Add session). ✅ RDP and VNC type tabs appear.
2. Add a VNC session (name + host + port 5900), save. ✅ Appears in sidebar with VNC icon.
3. Add an RDP session (name + host + port 3389 + username), save. ✅ Appears with RDP icon.
4. Click the saved VNC session. ✅ A VNC tab opens, prompts for password, begins connecting.
5. Click the saved RDP session. ✅ An RDP tab opens, prompts for password, begins connecting.
6. Quit and relaunch the app. ✅ Both saved RDP/VNC sessions still listed with name/color/folder.

## US2 — Organize & edit (P2)

1. Right-click a saved RDP/VNC session → Edit. ✅ Host/port/username editable; changes persist.
2. Assign a color + folder. ✅ Dot color + folder grouping shown.
3. Search by host. ✅ SSH, RDP, VNC matches returned together (FR-007).
4. Delete a session. ✅ Removed; stays gone after relaunch.

## US3 — Live verification (P3)

### SSH against the live VPS (DO NOW)
1. Save an SSH session to the VPS; click it; enter password. ✅ Interactive shell, accepts
   input, shows output (screenshot).
2. Open SFTP browser on that session. ✅ Remote files list + navigate.
3. Disconnect; click the saved session again. ✅ Reconnects without app restart.

### RDP/VNC UI flow (DO NOW)
4. Create/save/edit/launch an RDP and a VNC session. ✅ UI renders; a connection attempt is
   initiated (CONNECTING state visible).
5. Point one at an unreachable host. ✅ Inline error overlay + Retry button appears (FR-009).
6. Cancel a password prompt. ✅ Launch aborts, no orphan tab/connection.
7. Reconnect a session in the same run. ✅ No re-prompt (session password cache, FR-008).
8. Click an already-open saved session. ✅ Focuses the existing tab, no second connection (FR-012).

### Quick-connect promotion (FR-013)
9. Open the VNC/RDP quick-connect modal → "Save this connection". ✅ A saved session is created.

### DEFERRED — must be tracked, not skipped
- **[DEFERRED]** Live RDP render + input against a real RDP server.
- **[DEFERRED]** Live VNC render + input against a real VNC server.
  Record these as outstanding until the user stands up test servers.

## Credential safety check (FR-008 / SC-005)

After saving + launching sessions, confirm no remote-session password appears in:
- localStorage (the persisted `state.projects` records), and
- any file under `data/`.
✅ Zero plaintext passwords on disk.
