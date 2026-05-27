<!-- (C) -->
# Phase 2 — SSH Transport (local-build implementation guide)

> **Run this locally**, where the Rust/Tauri toolchain compiles (`npm run tauri dev`) and you can test against a real SSH host. It cannot be built in the cloud planning environment (Tauri's system libs — webkit2gtk/gtk/libsoup — aren't installed there).
>
> **Prereqs already shipped** (branch `pro-terminal-overhaul-phase-0-1`): the Session model (`type: 'local' | 'ssh'` + `connection: { host, port, user, auth }`), the SSH session dialog, and the sidebar session manager. Phase 2 only adds the *transport* behind the existing PTY event seam and removes the "preview" gate.

## The seam you're plugging into

The frontend never talks to a shell directly — it drives an opaque session id:

```
TerminalPane ── invoke("pty_spawn"|"ssh_spawn") ──► id
            ── invoke("pty_write" | "pty_resize" | "pty_kill", { id }) ──►
xterm ◄────────── event  pty://{id}  (string chunks) ──────────────────
        ◄──────── event  pty-exit://{id} ────────────────────────────
```

So an SSH session must: register in the same `SessionRegistry`, accept the same `pty_write`/`pty_resize`/`pty_kill`, and emit the same `pty://{id}` / `pty-exit://{id}` events. Then **zero** of the xterm/scrollback/cost/transcript/activity machinery changes.

## Crate choice — use `ssh2` (libssh2)

`ssh2` is **synchronous/blocking**, which matches `pty.rs`'s existing one-thread-per-session reader model exactly (the reader loop at `pty.rs:328-348`). It also bundles **SFTP**, which Phase 3 needs for free. `russh` (pure-Rust, async) is the fallback only if libssh2 linking proves painful on the target OS — but it forces a Tokio runtime bridged into Tauri's sync commands, which fights the current architecture.

```toml
# src-tauri/Cargo.toml  [dependencies]
ssh2 = "0.9"
```

Windows/macOS linking: `libssh2-sys` builds libssh2 from source via the `vendored-openssl` feature when a system lib isn't found (needs cmake + a C compiler — both present on the dev machines per CLAUDE.md's Build Tools note). If the default build can't find OpenSSL, enable: `ssh2 = { version = "0.9", features = ["vendored-openssl"] }`.

## Backend changes (`src-tauri/src/pty.rs`)

### 1. Make the registry transport-agnostic

Today `SessionRegistry.sessions: Mutex<HashMap<String, PtySession>>` and `PtySession` holds `master`/`child`/`writer`. Generalize to an enum so SSH and local share one registry and one set of commands:

```rust
enum Session {
    Local(PtySession),                 // existing struct, unchanged
    Ssh(SshSession),
}

struct SshSession {
    // ssh2 Channel is the read/write endpoint; keep the Session alive too so
    // the connection isn't dropped. ssh2 types are not Sync — guard with the
    // registry Mutex and only touch them while holding the lock.
    channel: ssh2::Channel,
    _sess: ssh2::Session,
}
```

`SessionRegistry.sessions` becomes `Mutex<HashMap<String, Session>>`. Update `pty_write`/`pty_resize`/`pty_kill`/`kill_all` to `match` on the enum:
- **write:** `Local` → `writer.write_all`; `Ssh` → `channel.write_all(data.as_bytes())` then `channel.flush()`.
- **resize:** `Local` → `master.resize(...)`; `Ssh` → `channel.request_pty_size(cols, rows, None, None)`.
- **kill:** `Local` → `child.kill()`; `Ssh` → `channel.close().ok(); channel.wait_close().ok();`.

### 2. Add `ssh_spawn`

Mirror `pty_spawn`'s shape and reuse `ScrollbackWriter` + the reader-thread pattern verbatim. Key difference: the reader does `channel.read(&mut buf)` instead of the PTY reader, and the channel is non-blocking-aware.

```rust
#[derive(serde::Deserialize)]
pub struct SshAuth { pub method: String, pub password: Option<String>, pub key_path: Option<String> }

#[tauri::command]
pub fn ssh_spawn(
    app: AppHandle,
    state: State<'_, SessionRegistry>,
    host: String, port: u16, user: String,
    auth: SshAuth,
    cols: u16, rows: u16,
    start_commands: Option<Vec<String>>,   // run after the shell is live (optional)
    tab_id: Option<String>,
) -> Result<String, String> {
    use std::net::TcpStream;
    let tcp = TcpStream::connect((host.as_str(), port)).map_err(|e| format!("connect failed: {e}"))?;
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| format!("handshake failed: {e}"))?;

    // ── Host-key verification (do NOT skip) ──
    // Read the server key fingerprint and check it against a known-hosts file in
    // the app data dir (commands::get_data_dir + "known_hosts"). On first sight,
    // surface the fingerprint to the UI for confirmation; on mismatch, REFUSE.
    verify_host_key(&sess, &app, &host, port)?;

    // ── Auth ──
    match auth.method.as_str() {
        "password" => sess.userauth_password(&user, auth.password.as_deref().unwrap_or(""))
            .map_err(|e| format!("auth failed: {e}"))?,
        "key" => {
            let key = auth.key_path.ok_or("no key path")?;
            sess.userauth_pubkey_file(&user, None, std::path::Path::new(&key), None)
                .map_err(|e| format!("key auth failed: {e}"))?;
        }
        "agent" => {
            let mut agent = sess.agent().map_err(|e| e.to_string())?;
            agent.connect().map_err(|e| e.to_string())?;
            agent.list_identities().map_err(|e| e.to_string())?;
            let ids = agent.identities().map_err(|e| e.to_string())?;
            let mut ok = false;
            for id in ids { if agent.userauth(&user, &id).is_ok() { ok = true; break; } }
            if !ok { return Err("agent auth failed".into()); }
        }
        other => return Err(format!("unknown auth method: {other}")),
    }
    if !sess.authenticated() { return Err("authentication failed".into()); }

    let mut channel = sess.channel_session().map_err(|e| e.to_string())?;
    channel.request_pty("xterm-256color", None, Some((cols as u32, rows as u32, 0, 0)))
        .map_err(|e| e.to_string())?;
    channel.shell().map_err(|e| e.to_string())?;

    // Non-blocking so the reader thread can poll without wedging on idle.
    sess.set_blocking(false);

    let id = new_session_id();
    // ... clone a reader handle. ssh2 Channel isn't cloneable like the PTY
    // reader; the common pattern is: keep the channel in the registry, and in
    // the reader thread hold an Arc<Mutex<Session>> OR re-open a read stream.
    // Simplest robust approach: move the channel into the reader thread, have
    // it own reads AND writes, and route pty_write through an mpsc::Sender that
    // the thread drains each loop. (See "Threading note" below.)
    Ok(id)
}
```

**Threading note (important):** `ssh2::Channel` is `!Sync` and the same channel is used for both reads (thread) and writes (`pty_write` command). Don't share it across threads behind a `Mutex` — instead, give the **reader thread sole ownership** of the channel and feed it an `mpsc::Receiver<Vec<u8>>` for writes + an `Arc<Atomic... >`/channel for resize+kill signals. The registry stores the `Sender` side (wrapped so `pty_write`/`resize`/`kill` push messages). The thread loop each tick: drain pending writes → `channel.write_all`; `channel.read` into buf → emit `pty://{id}` + `ScrollbackWriter::append`; check for resize/kill signals; `thread::sleep(Duration::from_millis(5))` when idle to avoid a busy-spin. On `channel.eof()` or read error → emit `pty-exit://{id}` and exit. This keeps the non-Sync channel on one thread and reuses the exact emit+scrollback code from `pty_spawn`.

This means the registry entry for SSH is really `{ writes: mpsc::Sender<Vec<u8>>, ctrl: mpsc::Sender<Ctrl> }`, not the raw channel — adjust the `Session::Ssh` variant accordingly. `pty_write` sends bytes; `pty_resize` sends `Ctrl::Resize(cols,rows)`; `pty_kill` sends `Ctrl::Kill` and removes the entry.

### 3. Run `start_commands` after connect

After `channel.shell()`, write each command + `\r` (with the same ~600ms initial delay the PTY path uses, `TerminalPane.jsx:583`) so post-connect commands (e.g. `claude`) run. Either do this in the reader thread before the read loop, or let the frontend send them via `pty_write` once connected (simpler — keep parity with how local start-commands are typed from `TerminalPane`).

### 4. Register the command (`src-tauri/src/lib.rs`)

Add `pty::ssh_spawn` to the `invoke_handler![...]` list (next to `pty::pty_spawn`, `lib.rs:113`).

## Frontend changes

### 1. Carry the connection onto the tab (`TerminalsTab.jsx`)

Remove the SSH gate in `openProjectInPanel` (the `toast.info("… upcoming release")` block added in Phase 1) and instead put the connection on the new tab:

```js
const newTab = {
  id: freshId("tab"),
  label: `${project.name}${labelSuffix}`,
  cwd: project.type === "ssh" ? null : project.path,
  startCommands: cmds,
  projectId: project.id,
  connection: project.type === "ssh" ? project.connection : null, // NEW
};
```

### 2. Dispatch in `TerminalPane.jsx`

Thread `connection` down (`TerminalsTab` → `TerminalPanel` pane render → `TerminalPane` prop). In the spawn effect (`TerminalPane.jsx:443-486`), branch:

```js
let id;
if (connection) {
  id = await invoke("ssh_spawn", {
    host: connection.host, port: connection.port || 22, user: connection.user,
    auth: connection.auth, cols, rows, startCommands: cmdsAtSpawn, tabId,
  });
} else {
  id = await invoke("pty_spawn", { cwd: cwd || null, cols, rows, extraEnv, tabId });
}
```

Everything after (`listen('pty://'+id)`, `pty_write`, `onResize`, scrollback replay, cost scan) is **unchanged** — SSH output flows through the identical path. For split panes, only the **root** pane of an SSH tab gets the connection (`isRoot` in `TerminalPanel.jsx`); split-off panes stay local shells (or, later, open additional channels on the same `ssh2::Session`).

### 3. Password handling

Don't persist plaintext passwords in localStorage. For Phase 2, prompt for the password at connect time (a small modal) and pass it transiently to `ssh_spawn`; never store it. The encrypted credential vault is Phase 4 (`keyring` crate). Key-path and agent auth need no secret storage.

## Verification (local)

1. `cd plutos-terminals && npm install && npm run tauri dev`.
2. Add an SSH session (host/user/key or password) in the sidebar; open it.
3. Confirm: interactive shell streams, `pty_resize` reflows on window resize, `exit` shows `[process exited]`, scrollback replays on reopen, MultiExec broadcast reaches the SSH pane, and a split inside an SSH tab opens a second (local) shell without dropping the SSH session.
4. Host-key: first connect surfaces the fingerprint; a changed key is refused.
5. `cargo clippy` clean; no `unwrap()` on network/auth paths.

## What this unlocks
- **Phase 3 (SFTP):** reuse the live `ssh2::Session` → `sess.sftp()`; add `sftp_list/stat/get/put/mkdir/rm/rename` commands + the dual-pane drawer.
- **Phase 4:** serial (`serialport`) as another `Session` variant behind the same seam; `keyring`-backed credential/key vault; ssh2 port forwarding.
