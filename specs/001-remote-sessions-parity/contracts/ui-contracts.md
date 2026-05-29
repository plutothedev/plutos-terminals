<!-- (C) -->
# Phase 1 UI Contracts: Unified Remote Sessions

This feature exposes no network/CLI API. Its contracts are the internal UI/state interfaces
between components. These are the seams tasks must honor.

## C1 — `ProjectDialog` onSave payloads (NEW type branches)

`ProjectDialog` calls `onSave(record)` with a type-tagged record. Existing `local` and `ssh`
payloads unchanged. New:

```js
// RDP
onSave({
  type: "rdp",
  name,                 // required, trimmed
  folder,               // string | null
  tags,                 // string[]
  rdp: { host, port, username, domain }, // port int (default 3389), domain "" → null
});

// VNC
onSave({
  type: "vnc",
  name,
  folder,
  tags,
  vnc: { host, port },  // port int (default 5900)
});
```

`canSave` for `rdp`/`vnc` = `name` non-empty AND `host` non-empty.

## C2 — `openProjectInPanel(panelId, projectId, overrideCommands?)` (EXTENDED)

Behavior added (in `TerminalsTab.jsx`):

1. **Focus existing (all types, FR-012)**: if any open tab has `projectId === projectId`,
   activate that panel + tab and return — do not create a new tab/connection.
2. **type === "vnc"**: build tab `{ id, label: name, vnc: { host, port }, projectId }`.
   Resolve password: cached-for-session → use it; else open the VNC password prompt; on
   cancel, abort. Then `spawnSessionTab`.
3. **type === "rdp"**: same as VNC with `rdp: { host, port, username, domain }`.
4. Missing required connection fields → `toast.error` and return (mirror SSH guard).

## C3 — Transient password cache (NEW, in `TerminalsTab.jsx`)

```js
rememberSessionPassword(sessionId, secret) // in-memory map, app-run lifetime
getSessionPassword(sessionId) -> secret | undefined
forgetSessionPassword(sessionId)           // wired to sidebar "forget" context action
```

`VncView` / `RdpView` continue to receive the password via the existing `ptyBridge` tab-keyed
mechanism at connect time; the session cache only avoids re-prompting.

## C4 — `api` object (consumed by `MobaHomeScreen`) — additions

The `api` object passed to `MobaHomeScreen` keeps `openProject`, `vnc`, `rdp`, etc. The
saved-session grid must map `p.type` → icon for `rdp`/`vnc` (not just ssh/local).

## C5 — Quick-connect modals "Save this connection" (FR-013)

`VncConnectModal` / `RdpConnectModal` gain an optional callback:

```js
onSaveSession({ type: "vnc"|"rdp", name, host, port, username?, domain? })
```

Invoking it adds a saved session (same shape as C1) to `state.projects`. The ephemeral
`onConnect` path is unchanged. Password is NOT included in the saved record.

## C6 — `VncView` / `RdpView` error contract (FR-009)

Each view manages a local status: `connecting | connected | error`. On the existing
`vnc-exit` / `rdp-exit` event (or connect rejection), transition to `error` and render an
overlay with the reason + a **Retry** button. Retry re-runs the connect invocation with the
same props. No new backend events required.

## C7 — `ProjectSidebar` type affordances

Sidebar type detection extended so `type === "rdp" | "vnc"` render distinct icons and are
included in name/host/folder search (FR-007). Color, folder, rename, edit, delete, and the
"forget password" context action apply to rdp/vnc records using the existing generic
handlers (`onColorProject`, `onSetFolder`, `onEditProject`, `onRemoveProject`,
`onForgetPassword`).
