// (C)
// Credential vault for SSH secrets, backed by the OS keychain (macOS Keychain /
// Windows Credential Manager / Linux Secret Service) via the `keyring` crate.
// Secrets never live in localStorage or any plaintext file — the OS guards them
// and may prompt the user for keychain access. The frontend keys an SSH password
// by account = "{user}@{host}:{port}". Secrets are never logged.
//
// Threading: the `#[tauri::command]` entry points are async + spawn_blocking. A
// non-async command runs INLINE on the webview's UI event-loop thread, and a
// locked or prompting keychain blocks for as long as the user takes to answer,
// which froze the whole window (all tabs, panes, keystrokes). Same defect class
// and same fix as ssh_key_generate (audit H6). The `*_sync` bodies stay public
// for Rust callers that are already off the UI thread (share.rs, mcp/manager.rs).

use keyring::Entry;

const SERVICE: &str = "com.plutothedev.terminals.ssh";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Store (or overwrite) a secret for `account`. Blocking: never call on the UI thread.
pub fn secret_set_sync(account: String, secret: String) -> Result<(), String> {
    entry(&account)?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

/// Fetch a secret. Returns None when nothing is stored (not an error). Blocking.
pub fn secret_get_sync(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret. A missing entry is treated as success (idempotent). Blocking.
pub fn secret_delete_sync(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Store (or overwrite) a secret for `account`.
#[tauri::command]
pub async fn secret_set(account: String, secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secret_set_sync(account, secret))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}

/// Fetch a secret. Returns None when nothing is stored (not an error).
#[tauri::command]
pub async fn secret_get(account: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || secret_get_sync(account))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}

/// Delete a secret. A missing entry is treated as success (idempotent).
#[tauri::command]
pub async fn secret_delete(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secret_delete_sync(account))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}
