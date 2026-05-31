<!-- (C) -->
# Phone / Web Companion — "Remote Control" Design

**Goal (tracked):** drive this feature to completion through **all phases** so Pluto
has a working Warp-style remote control — control your running desktop Pluto from
your phone (or any browser): see sessions, type/run commands, read output, switch
between sessions, and get pinged when a long command finishes — building toward
**full parity** with the desktop app.

Status (2026-05-31): **Phases 1–4 built, verified end-to-end, and shipped** on
branch `001-remote-sessions-parity`. Phase 5 (push-when-closed) is the remaining
optional phase — blocked on HTTPS infrastructure (see below). The companion is
usable today: Tools → "Remote control (phone)…" (or ⌘K → "Remote control") →
Start, then scan the QR / open the link on a phone on the same tailnet.

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

| Phase | Deliverable | Status |
|---|---|---|
| **1 — Transport + 1 session** | companion server (serve + WS), QR pairing + revocable token auth, the frontend `Backend` seam, web client that **mirrors + types into the active session**. | ✅ **Done.** Verified: bad token rejected; auth→ready; live `pty://` relay; a typed command runs in the real shell and its output streams back. |
| **2 — Multi-session + notify** | session list, switch sessions, command-finished alerts (OSC-133), reconnect/resilience. | ✅ **Done.** Subscribes to every session; per-tab activity badges; OSC-133 `133;D` → browser notification (silent on bare prompt redraws); reconnect re-arms subs. |
| **3 — Create sessions** | start local / SSH sessions from the phone. | ✅ **Done (local).** "＋" → `new_session` → desktop `addTab` → new shell appears in the list (verified 13→14). SSH-from-phone deferred (needs an interactive credential prompt). |
| **4 — File browser + rest** | SFTP / local browser, snippets, models, etc. → **full parity**. | ✅ **File browser done** (read-only `list_directory`, navigate, "cd here"). Remaining parity (snippets, model picker, other dialogs) is incremental: one allow-list entry + a small panel each. |
| **5 (opt) — push when closed** | Tailscale HTTPS cert + service worker + web push for "build done" when the tab is closed. | ⏸ **Blocked on HTTPS** (see below). |

### Phase 5 prerequisites (why it isn't built yet)

Service workers and the Web Push API both require a **secure context (HTTPS)** —
they do not register over plain `http://` except on `localhost`. The companion
currently serves `http://<tailnet-ip>:8390`, so the whole phase is gated on TLS:

1. **HTTPS over the tailnet** — `tailscale cert <magicdns-name>` (requires
   Tailscale running with HTTPS/MagicDNS enabled on the tailnet) → serve the
   companion with that cert (axum + `axum-server`/rustls), or front it with
   `tailscale serve`.
2. **Service worker** (`/sw.js`) + a web-app manifest (installable PWA).
3. **Web Push** — generate VAPID keys (server), the page subscribes
   (`pushManager.subscribe`), the server stores the subscription and sends pushes
   via a `web-push` crate.
4. **Server-side command-finish detection** — move the OSC-133 `133;D` scan into
   the Rust event relay (it's client-side today) so the server can push even when
   the tab is closed.

This needs real-device + cert testing (a browser, a push service, a provisioned
tailnet cert) that wasn't available in the build environment, so it's left as a
clean follow-on rather than shipped unverified.

## Protocol sketch (Phase 1)

WebSocket, JSON frames:

- `→ { "type": "auth", "token": "<device-token>" }` (first frame; server validates)
- `→ { "type": "rpc", "id": <n>, "cmd": "pty_write", "args": { "id": "...", "data": "..." } }`
  `← { "type": "rpc-result", "id": <n>, "ok": <value> | "err": "..." }`
- `→ { "type": "subscribe", "channel": "pty://<id>" }`
  `← { "type": "event", "channel": "pty://<id>", "data": "<chunk>" }`

The RPC `cmd` set is a small server-side allow-list (not the full Tauri surface),
so a leaked token can only reach what the page needs:
`scrollback_load`, `default_shell`, `system_stats`, `pty_write`, `pty_resize`,
`list_sessions`, `list_directory` (read-only), and `new_session` (asks the desktop
to open a tab). Notably **no `write_store`** — the companion never overwrites the
desktop's persisted layout. The session list (`{id, tabId, label, active}`) is
pushed from the desktop via `companion_set_sessions`, because the page can't read
the webview's localStorage and the per-spawn `pty://` channel ids live only in
each `TerminalPane` (published to `ptyBridge` via `setPtyId`).

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
