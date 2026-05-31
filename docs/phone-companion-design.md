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

- **Token auth (today): a single shared, per-run bearer token.** `start()` mints
  one 40-char random token; it gates the WebSocket (first frame) and is embedded
  in the QR link's hash so scanning auto-connects. "Revocation" today is global —
  stop/restart mints a fresh token (invalidating the old). There is **no**
  per-device pairing/exchange, **no** `vault.rs`-stored device token, and **no**
  per-device list/revoke yet — those are future work (below).
- **Bind:** the server binds `0.0.0.0:<port>` (all interfaces). The *intended*
  reach is the tailnet, with Tailscale device auth as the outer gate — but the
  bind itself is not tailnet-scoped, so when Tailscale is down the port is also
  LAN-reachable, gated only by the token. (Binding the tailnet IP / warning when
  Tailscale is down is a hardening follow-up.)
- Server is **off by default**; the user explicitly enables it.

**Future (not built):** per-device pairing (a short-lived pairing token exchanged
for a long-lived device token stored in `vault.rs`), a connected-device list, and
per-device revoke. The current model is the single shared token described above.

## Phases (the "all phases" to complete)

| Phase | Deliverable | Status |
|---|---|---|
| **1 — Transport + 1 session** | companion server (serve + WS), QR + a single shared bearer token (rotated on restart), the frontend `Backend` seam, web client that **mirrors + types into the active session**. | ✅ **Done.** Verified: bad token rejected; auth→ready; live `pty://` relay; a typed command runs in the real shell and its output streams back. |
| **2 — Multi-session + notify** | session list, switch sessions, command-finished alerts (OSC-133), reconnect/resilience. | ✅ **Done.** Subscribes to every session; per-tab activity badges; OSC-133 `133;D` → browser notification (silent on bare prompt redraws); reconnect re-arms subs. |
| **3 — Create sessions** | start local / SSH sessions from the phone. | ✅ **Done (local).** "＋" → `new_session` → desktop `addTab` → new shell appears in the list (verified 13→14). SSH-from-phone deferred (needs an interactive credential prompt). |
| **4 — File browser + rest** | SFTP / local browser, snippets, models, etc. → **full parity**. | ✅ **File browser done** (read-only `list_directory`, navigate, "cd here"). 🔨 **Snippets + model picker built** (pending `cargo build` + on-device verify): snippets pushed from the desktop → tap to insert into the active session (`{{var}}` fill); model picker pushes the catalog + active selection with **`hasKey` only — API keys never leave the desktop** → picking sets `activeModel` for the next-spawned shell. Other dialogs remain incremental: one allow-list entry + a small panel each. |
| **5 (opt) — push when closed** | Tailscale HTTPS + service worker + web push for "build done" when the tab is closed. | 🔨 **Built (pending on-device verify).** HTTPS via `tailscale serve` (loopback bind); PWA manifest + `sw.js`; VAPID web-push (keys in the OS keychain); the desktop "agent finished" hook → `companion_notify_finish` → push when no phone is connected. cargo + vite green; needs a real phone to confirm the push round-trip. |

### Phase 5 — as built (push-when-closed)

Built once tailnet HTTPS was enabled; **compile-verified (cargo + vite), pending
on-device confirmation** of the push round-trip. How it maps to the original
prerequisites:

1. **HTTPS** — the companion now binds `127.0.0.1:8390` and is fronted by
   **`tailscale serve --bg 8390`**, which terminates TLS on the MagicDNS name and
   auto-provisions/renews the cert. The QR/URL becomes `https://<magicdns>/#<token>`.
   This also removes the old all-interfaces (`0.0.0.0`) exposure. Serve is left
   configured on stop (`tailscale serve reset` removes it).
2. **PWA** — `companion-web/manifest.webmanifest` + `companion-web/sw.js`, served
   at root scope via `include_str!`'d routes; install `<meta>` tags in the page.
3. **Web Push (VAPID)** — a P-256 keypair is generated on first use and stored in
   the **OS keychain** (never on disk). New WS RPCs `vapid_public_key` (the page's
   `applicationServerKey`) and `push_subscribe` (stores the browser subscription,
   also keychained). Sends go through the `web-push` crate (`hyper-client`).
4. **Command-finish detection — reuses the desktop's existing detector** instead of
   a new server-side scan: the desktop already fires a "done" cue + OS notification
   on the agent active→done transition (`TerminalPane.jsx`); that hook now also
   calls `companion_notify_finish`, which web-pushes **only when no phone WS is
   connected** (`ws_count == 0`) and a subscription exists. The desktop is always
   alive, so this satisfies "push when the phone tab is closed" without a fragile
   per-session relay scanner. (Deviates from the literal "move the scan into the
   Rust relay" wording, same goal.)

**Deferred:** vendoring xterm same-origin (it still loads from a CDN — fine for
push, but a true offline PWA + the supply-chain hardening want it self-hosted).

**On-device verification (TODO):** open `https://<magicdns>/` on the phone over the
tailnet, grant notifications (iOS: *Add to Home Screen* first — Web Push needs an
installed PWA), background/close the tab, trigger a long agent/command finish on
the desktop while away, and confirm the push arrives.

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
