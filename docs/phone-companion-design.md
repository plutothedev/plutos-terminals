<!-- (C) -->
# Phone / Web Companion — "Remote Control" Design

**Goal (tracked):** drive this feature to completion through **all phases** so Pluto
has a working Warp-style remote control — control your running desktop Pluto from
your phone (or any browser): see sessions, type/run commands, read output, switch
between sessions, and get pinged when a long command finishes — building toward
**full parity** with the desktop app.

Status: design approved (brainstorm 2026-05-31). Next: Phase 1.

---

## Decisions (from the brainstorm)

- **Experience:** phone/web companion that *controls* the running desktop Pluto
  (not a separate cut-down app; not pixel-mirroring).
- **Reach:** **Tailscale** — the desktop runs a small HTTP+WebSocket server bound
  to a tailnet-reachable address; the phone connects over the user's tailnet from
  anywhere. No relay to host, nothing exposed publicly. Tailscale provides the
  device-level encryption/auth (outer gate); the app adds a token (inner gate).
- **Scope:** **full parity** — reached *incrementally*, not by re-implementing the
  app twice.

## Architecture — reuse the app over a transport seam

The desktop UI is already React + xterm.js talking to the Rust backend via Tauri
`invoke()` / event `listen()`. Parity comes for free if we abstract that one
access layer and serve the *same* React bundle to the phone over WebSocket.

```
            ┌──────────────────────── Desktop (Tauri app) ───────────────────────┐
            │  React UI ──Backend interface──┬─ Tauri IPC impl (invoke/listen)    │
            │                                └─ (unchanged on desktop)            │
            │  Rust backend: SessionRegistry (PTYs), sftp, vault, …               │
            │      └── companion.rs: axum + tokio-tungstenite HTTP+WS server      │
            │             • static-serves the built web client                    │
            │             • WS: RPC (mirrors Tauri cmds) + event relay            │
            │             • token auth, binds tailnet iface                       │
            └───────────────┬─────────────────────────────────────────────────────┘
                            │  Tailscale (tailnet)
            ┌───────────────┴───────────── Phone / browser ──────────────────────┐
            │  SAME React bundle ──Backend interface── WS impl (to companion srv) │
            └─────────────────────────────────────────────────────────────────────┘
```

### Components

1. **`src-tauri/src/companion.rs` (new).** An `axum` + `tokio-tungstenite`
   HTTP+WS server (the project already pulls `tokio` transitively via the SSH
   stack; add `axum` + `tokio` + `tokio-tungstenite` to Cargo). It:
   - static-serves the built web client (the same `dist/`),
   - exposes a WS protocol that **mirrors the Tauri command surface** — an RPC
     channel (`pty_spawn`, `pty_write`, `pty_resize`, `sftp_*`, `system_stats`, …)
     plus an **event relay** that forwards the `pty://{id}` / `pty-exit://{id}`
     chunks already emitted by `pty.rs` (subscribe the WS client to a session's
     stream),
   - authenticates each connection with a device token,
   - binds to the tailnet-reachable address (e.g. `0.0.0.0:<port>` reachable only
     over the tailnet, or the Tailscale interface IP).

2. **Frontend `Backend` transport seam.** Wrap `invoke()` and `listen()` behind a
   small interface with two implementations — **Tauri** (`window.__TAURI__`
   present) and **WS** (browser). The rest of the React app calls the interface
   and is otherwise unchanged. The "companion build" is the same bundle with the
   WS backend selected at runtime.

3. **Desktop "Remote control" panel.** Start/stop the companion server, show the
   tailnet URL + a **QR code** (URL + pairing token), list connected devices, and
   revoke a device.

4. **Notifications.** OSC-133 done-marks already fire on the desktop; relay them
   to the companion for an in-app "✓ build finished" alert. Push-when-closed needs
   a secure context (Tailscale can issue a tailnet HTTPS cert) + a service worker
   + web push → Phase 5.

### Security (the crux — a token = full shell access)

- **Revocable, per-device tokens.** The QR carries a short-lived *pairing* token
  that the phone exchanges for a long-lived *device* token (stored via the
  existing OS keychain `vault.rs`). Each device is listed + revocable.
- **Bind tailnet only** so Tailscale's device auth is the outer gate.
- Server is **off by default**; the user explicitly enables it.

## Phases (the "all phases" to complete)

| Phase | Deliverable | Notes |
|---|---|---|
| **1 — Transport + 1 session** | companion server (serve + WS), QR pairing + revocable token auth, the frontend `Backend` seam, web client that **mirrors + types into the active session**. | The meat: new Rust server + the transport refactor. Proves the loop end-to-end. |
| **2 — Multi-session + notify** | session list, switch sessions, command-finished alerts (OSC-133), reconnect/resilience. | |
| **3 — Create sessions** | start local / SSH sessions from the phone. | |
| **4 — File browser + rest** | SFTP / local browser, snippets, models, etc. → **full parity**. | Mostly free once the seam covers the commands. |
| **5 (opt) — push when closed** | Tailscale HTTPS cert + service worker + web push for "build done" when the tab is closed. | |

## Protocol sketch (Phase 1)

WebSocket, JSON frames:

- `→ { "type": "auth", "token": "<device-token>" }` (first frame; server validates)
- `→ { "type": "rpc", "id": <n>, "cmd": "pty_write", "args": { "id": "...", "data": "..." } }`
  `← { "type": "rpc-result", "id": <n>, "ok": <value> | "err": "..." }`
- `→ { "type": "subscribe", "channel": "pty://<id>" }`
  `← { "type": "event", "channel": "pty://<id>", "data": "<chunk>" }`

The RPC `cmd` set is exactly the Tauri command names, so the frontend WS backend
is a thin shim: `invoke(cmd,args)` → send rpc frame, await rpc-result;
`listen(channel,cb)` → subscribe + dispatch event frames.

## Risks / open questions

- **Transport refactor surface.** Every `invoke`/`listen` call site must route
  through the seam. Bounded but broad — inventory them in Phase 1.
- **Tauri-only APIs.** Window control, native dialogs, `spawn_new_window`, clipboard
  — need WS equivalents or graceful degradation on the phone.
- **Mobile responsiveness.** The desktop layout isn't touch-first; full parity
  implies responsive work, done incrementally (Phase 1 can ship a desktop-ish
  layout that's usable on a phone, then refine).
- **v0/v1 gating.** Per `CLAUDE.md` this is v1+; ship after v0 is solid. This goal
  is to have it designed + built phase-by-phase, not to jump ahead of v0.
