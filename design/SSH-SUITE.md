<!-- (C) -->
# Remote sessions — SSH / SFTP / vault / tunnels / serial (architecture)

What shipped on branch `pro-terminal-overhaul-phase-0-1` after the Phase 0/1 overhaul, and how it hangs together. Implementation guide for the original SSH transport is in `PHASE-2-SSH-TRANSPORT.md`; this is the as-built summary across all the remote features.

## The one seam everything rides on

The renderer never talks to a shell, host, or device directly — it drives an opaque session **id** and listens for events:

```
TerminalPane ── invoke("pty_spawn" | "ssh_spawn" | "serial_spawn") ──► id
             ── invoke("pty_write" | "pty_resize" | "pty_kill", { id }) ──►
xterm ◄──────── event  pty://{id}      (UTF-8 chunks) ───────────────────
       ◄─────── event  pty-exit://{id} ──────────────────────────────────
```

`SessionRegistry` (in `pty.rs`, Tauri-managed state) holds a `Session` enum so all three transports share one registry and one command set — none of the xterm / scrollback / cost / activity machinery knows the difference:

```rust
enum Session { Local(PtySession), Ssh(SshHandle), Serial(SerialHandle) }
```

`pty_write` / `pty_resize` / `pty_kill` / `kill_all` `match` on the variant. `TerminalPane` picks the spawn command from the tab: `serial` → `serial_spawn`, else `connection` → `ssh_spawn`, else `pty_spawn`. In a split tab, only the **root** pane carries the SSH/serial identity; split-off panes are local shells.

## Why later features each open their own connection

`ssh2` types (`Session`, `Channel`, `Sftp`) are **`!Sync`**. The interactive shell's `ssh2::Session` is *moved into its reader thread*, so it can't be borrowed from a command. Therefore **every SSH-derived feature opens its own dedicated connection on its own worker thread**, all reusing one authenticated-connect helper:

`pty::connect_session(host, port, user, &auth)` → TCP → handshake → **host-key verify** → auth → blocking `ssh2::Session`.

| Feature | Module | Threading model |
|---|---|---|
| Shell | `pty.rs` `ssh_spawn` | One reader thread owns the channel; writes/resize via `mpsc`; kill = drop handle (sender disconnect). Non-blocking. |
| SFTP | `sftp.rs` | Request/response worker owns `Session`+`Sftp`; each command sends an `mpsc` request and blocks on the reply (a slow transfer never blocks the shell). Blocking. |
| Port forward | `forward.rs` | One worker owns a dedicated session + `TcpListener` (127.0.0.1 only) + every proxied socket; non-blocking with per-direction `VecDeque` buffers (real flow control, no dropped bytes). `channel_direct_tcpip` per accept. |
| Serial | `pty.rs` `serial_spawn` | `serialport` reader thread with a short read timeout + `alive` flag so `pty_kill` stops it promptly. |

**EAGAIN:** ssh2's `io::Read`/`Write` impls surface non-blocking as `WouldBlock`; `channel_direct_tcpip` surfaces it as `ssh2::ErrorCode::Session(-37)`.

## Security stances (held throughout)

- **Host keys verified** against `~/.ssh/known_hosts`: known-match connects, **changed key is refused** (MITM guard), first-seen is pinned (OpenSSH accept-new). Never skipped.
- **Passwords**: prompted transiently (`SshPasswordModal`) and passed to the backend via the in-memory `ptyBridge` — never localStorage. Opt-in **keychain vault** (`vault.rs`, `keyring`: macOS Keychain / Windows Credential Manager) persists them; "Forget saved password" deletes. Keyed `user@host:port`.
- **Port forwards bind `127.0.0.1` only** — never exposed to the LAN.
- No `unwrap()` on any network / auth / transfer path. Secrets are never logged.

## Build notes

- `ssh2` uses `vendored-openssl` — builds OpenSSL from source so binaries are self-contained and avoid the arm64-vs-Intel-Homebrew link mismatch. (Symptom if reverted: `cargo check` passes but `cargo build` fails at link with "symbol(s) not found for architecture arm64".)
- `keyring` features `apple-native` + `windows-native`; `serialport = "4"` (links system IOKit on macOS). All link self-contained on arm64.

## Command inventory

`ssh_spawn` · `serial_spawn` · `serial_list` · `sftp_connect` / `sftp_home` / `sftp_list` / `sftp_download` / `sftp_upload` / `sftp_mkdir` / `sftp_remove` / `sftp_rename` / `sftp_disconnect` · `secret_set` / `secret_get` / `secret_delete` · `port_forward_start` / `port_forward_stop` — all registered in `lib.rs`.

## Frontend surfaces

`ProjectDialog` (typed local/SSH sessions) · `SshPasswordModal` (transient password + remember) · `SftpBrowser` (`📁 files`) · `TunnelsModal` (`⇄ tunnels`) · `SerialModal` (`⎓ serial`) · sidebar "Forget saved password". All themed via `--phn-*` skin vars; the SSH-only toolbar buttons disable when the active tab isn't an SSH session.
