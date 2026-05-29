<!-- (C) -->
# Phase 1 Data Model: Unified Remote Sessions

The data model extends the existing `state.projects` saved-session records. No new store.

## Saved Session record (in `state.projects`)

Common fields (all types):

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `proj_…`, generated |
| `name` | string | display name (required) |
| `type` | `"local" \| "ssh" \| "rdp" \| "vnc"` | discriminator; legacy records infer `ssh` if `connection` present else `local` |
| `folder` | string \| null | sidebar grouping |
| `color` | string \| null | color dot id |
| `tags` | string[] | searchable labels (max 8) |

Type-specific fields:

**local**
| Field | Type | Notes |
|-------|------|-------|
| `path` | string | cwd to spawn the shell |
| `startCommands` | string[] | run on open |
| `autoApprove` | boolean | Claude auto-approve |

**ssh** (unchanged)
| Field | Type | Notes |
|-------|------|-------|
| `connection` | `{ host, port, user, auth: { method, keyPath } }` | no secret stored here |
| `proxyJump` | string \| null | name of a saved bastion session |
| `startCommands` | string[] | run after connect |

**rdp** (NEW)
| Field | Type | Notes |
|-------|------|-------|
| `rdp` | `{ host, port, username, domain }` | `domain` optional/null; **no password** |

**vnc** (NEW)
| Field | Type | Notes |
|-------|------|-------|
| `vnc` | `{ host, port }` | **no password** |

### Validation rules

- `name` required for all types.
- `rdp`: `host` required, `port` defaults to 3389, `username` recommended, `domain` optional.
- `vnc`: `host` required, `port` defaults to 5900.
- Passwords are never part of a saved record (FR-008).
- Saving is disabled until required fields are present (existing `canSave` pattern extended).

## Tab record (transient, in `state.panels[].tabs[]`)

A tab is exactly one type, discriminated by which field is set (existing pattern):

| Field present | Tab kind | Renderer |
|---------------|----------|----------|
| `home: true` | launch screen | `MobaHomeScreen` |
| `cwd` (+ no remote field) | local/SSH PTY | `TerminalPane` |
| `connection` | SSH PTY | `TerminalPane` |
| `vnc: { host, port }` | VNC desktop | `VncView` |
| `rdp: { host, port, username, domain }` | RDP desktop | `RdpView` |

All saved-session-launched tabs carry `projectId` (used for focus-existing, FR-012).

## Transient credential cache (in-memory, NOT persisted)

| Key | Value | Lifetime |
|-----|-------|----------|
| `ptyBridge` tab password (existing) | secret string keyed by tab id | read at spawn |
| remote-session password cache (NEW) | secret keyed by **session id** | app run; cleared on "forget" or app exit |

The session-id cache is what lets a same-run reconnect skip the prompt (FR-008). "Forget"
clears the entry for that session.

## State transitions — saved remote-desktop session

```text
(no session)
   │  user adds via ProjectDialog (rdp/vnc) OR "Save this connection" in quick-connect modal
   ▼
SAVED (in state.projects, persisted)
   │  click in sidebar / home grid → openProjectInPanel
   ▼
LAUNCHING ── tab already open for this projectId? ──► FOCUS existing tab (FR-012)
   │  no existing tab
   ▼
PASSWORD ── cached for session? ──► use cached
   │  not cached                         │
   │  prompt modal                       │
   │   ├─ cancel → ABORT (no tab, no connection)
   │   └─ submit → cache for session ────┤
   ▼                                      ▼
CONNECTING (tab open, VncView/RdpView)
   ├─ success → CONNECTED (framebuffer renders)
   └─ exit/error event → ERROR overlay + Retry ──► CONNECTING
```
