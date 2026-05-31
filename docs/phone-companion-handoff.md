<!-- (C) -->
# Phone Companion — Session Handoff (2026-05-31)

Pick-up doc for the Warp-style **phone/web remote control**. Everything below is
committed on branch `001-remote-sessions-parity` and pushed to **both** remotes
(`origin` = public mirror, `private` = build repo). Working tree clean.

> Full design + phase status: `docs/phone-companion-design.md`.

## TL;DR

Phases **1–4 are built, verified end-to-end, and shipped**. Phase **5
(push-when-closed) is the only one left and is blocked on HTTPS infra** (not on
code). The feature works today: **Tools → "Remote control (phone)…"** (or
**⌘K → "Remote control"**) → **Start server** → scan the QR / open the link on a
phone on the same Tailscale tailnet.

## Where things are

| Layer | File | What it holds |
|---|---|---|
| Rust server | `src-tauri/src/companion.rs` | axum HTTP+WS; token auth; RPC dispatch allow-list; `pty://` event relay (`app.listen`↔`app.emit`); `companion_start/stop/status/set_sessions`; `best_host()` (tailscale ip → LAN → localhost) |
| Phone page | `src-tauri/companion-web/index.html` | self-contained xterm page (CDN esm); login/token gate; multi-session tabs + badges; OSC-133 notify; "＋" new session; 📁 file browser. **`include_str!`'d into the binary → editing it requires a Rust rebuild** |
| Desktop panel | `src/features/terminals/RemoteControlModal.jsx` | Start/stop + QR + link + token + host:port |
| Transport seam | `src/backend.js` (`@backend` alias) | `invoke`/`listen` indirection (27 src files migrated); Tauri impl today, WS impl is the future full-app-reuse path |
| Session-list bridge | `src/features/terminals/ptyBridge.js` (`setPtyId`/`getPtyId`) + `TerminalsTab.jsx` (push effect + `companion://new-session` listener) | see "Key design facts" |
| Lib wiring | `src-tauri/src/lib.rs` | `mod companion; .manage(CompanionState) ; companion_*` in invoke_handler |

Commits: `1ed770e` P1a · `8a63161` P1b · `6c21b5c` P1c–e · `cfd2f96` P2 ·
`2a7c066` P3 · `998dbb0` P4 · `93dddc2` docs.

## Phase status

- **P1 — transport + mirror + type** ✅ verified: bad token rejected; auth→ready;
  live `pty://` relay; typed `echo $((a+b))` ran in the real shell, output relayed back.
- **P2 — multi-session + notify** ✅ subscribes to every session; per-tab badges
  (amber=running, cyan=unseen, red ✗=failed); OSC-133 `133;D` → browser
  Notification (silent on bare-prompt `133;D` with no preceding `133;C`); reconnect re-arms subs.
- **P3 — create from phone** ✅ verified 13→14: "＋" → `new_session` RPC →
  `companion.rs` emits `companion://new-session` → `TerminalsTab` `addTab` → real shell.
  Local shell only (SSH-from-phone deferred — needs interactive credential prompt).
- **P4 — file browser** ✅ verified: read-only `list_directory` → browse home,
  navigate subdirs, "cd here" sends `cd '<path>'` to the active session.
- **P5 — push-when-closed** ⏸ BLOCKED on HTTPS (see below).

## Phase 5 — what's needed (the only remaining work)

Service workers + Web Push require a **secure context (HTTPS)**; the companion
serves plain `http://<tailnet-ip>:8390`, so the whole phase is gated on TLS.
Tailscale isn't even running on this machine (server fell back to LAN IP
`192.168.1.142`). To build it:

1. `tailscale cert <magicdns-name>` (Tailscale up, HTTPS/MagicDNS enabled) → serve
   companion via rustls (`axum-server`), or front with `tailscale serve`.
2. Service worker `/sw.js` + web-app manifest (installable PWA).
3. VAPID keys (server) → page `pushManager.subscribe` → server stores subscription
   → push via a `web-push` crate.
4. Move the OSC-133 `133;D` command-finish scan into the **Rust** event relay
   (it's client-side today) so the server can push when the tab is closed.

Needs real-device + cert testing — don't ship it unverified.

## Key design facts (so you don't re-derive them)

- **Session list is PUSHED from the desktop** (`companion_set_sessions`), not read
  on the server. Reason: the page can't read the webview's localStorage (where the
  panel/tab layout lives), and the `pty://<id>` channel ids are minted per-spawn
  (`new_id("pty")` in `pty.rs`, NOT the tab id) and live only in each live
  `TerminalPane`. Each pane publishes its id to `ptyBridge` via `setPtyId`;
  `TerminalsTab` joins `state.panels` + the bridge into
  `[{id, tabId, label, active}]` (split-aware) and pushes on change. The WS
  `list_sessions` serves it. `id` = pty channel (subscribe + write/resize);
  `tabId` = scrollback key.
- **Relay needs no `pty.rs` change.** Tauri v2 plain `app.emit` fires ALL
  listeners regardless of target (verified in the crate source: `emit_filter`
  with `None` → every listener runs), so the companion's Rust-side `app.listen`
  receives the same `pty://` chunks the desktop webview gets.
- **Allow-list is least-privilege:** `scrollback_load`, `default_shell`,
  `system_stats`, `pty_write`, `pty_resize`, `list_sessions`, `list_directory`,
  `new_session`. **No `write_store`** (don't let a leaked token overwrite the
  desktop layout). Token = full shell access → server off by default, revocable
  (stop/restart mints a fresh one).
- Page is `include_str!`'d → **a page-only change still needs `cargo build`** +
  app relaunch. Frontend (React) changes hot-reload via vite.

## How to run + verify

```bash
cd /Users/michaelcinnamon/plutos-terminals
npm run tauri dev          # dev URL http://localhost:5310
```

Start the server: **Tools → "Remote control (phone)…" → Start server** (or
**⌘K → "Remote control" → Enter**). It binds `0.0.0.0:8390` (tailnet/LAN-reachable,
nothing public). Stop it when done — restart issues a fresh token.

**Headless verification recipe** (used for all four phases): start the server in
the UI, read the token off the modal, then drive the WS from Node (v22+ has a
global `WebSocket`):

```js
const ws = new WebSocket("ws://127.0.0.1:8390/ws");
ws.onopen = () => ws.send("<token-from-modal>");   // first frame = token
// then send {type:"rpc",id,cmd,args} and {type:"subscribe",channel:"pty://<id>"}
// expect {type:"ready"}, {type:"rpc-result",...}, {type:"event",channel,payload}
```
Scratch test clients from this session live in `/tmp/ws_*.mjs` (not committed).

## Peekaboo / UI-automation gotchas (macOS, this app's WKWebView)

These cost real time — they're here so you don't rediscover them:

- `inspect_ui`/`see` often fail **"no windows"** right after a relaunch. Fix:
  **click once into the window** (e.g. `click {coords:"700,400"}`) to wake AX, then retry.
- `image --capture_focus foreground` **steals focus** — it kills the next keystroke
  into a webview field. Don't screenshot between opening a palette/field and typing.
  Its PNG is 1440×900, **1:1 with the window** at screen origin `(144, 62)`
  → `screen = (144+x, 62+y)`.
- **Webview button clicks by coords only HOVER** (set the highlight, don't fire
  onClick). Use `click {on: <elemID>}` from a fresh `see` snapshot instead.
- Reliable "start the server" sequence: wake AX → `see` → click `Tools` elem →
  `inspect_ui --mode menus` → click `Remote control (phone)…` elem → `see` →
  click `Start server` elem → read token by cropping the token row from an `image`
  (`sips --cropToHeightWidth 30 460 --cropOffset 562 522` then upscale).
- `companion_stop` works, but the OS socket lingers a few seconds during axum's
  graceful drain before the port frees — that's normal, not a bind-reuse bug.

## Repo / release context

- Two remotes: `origin` (public `plutos-terminals`), `private`
  (`plutos-terminals-app`, the build repo). Push to both:
  `git push && git push origin 001-remote-sessions-parity`.
- This is v1+ work per `CLAUDE.md` (ship after v0 is solid). Branch is **not**
  merged to `main`.
