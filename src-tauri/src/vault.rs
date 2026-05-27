// (C)
// Credential vault for SSH secrets, backed by the OS keychain (macOS Keychain /
// Windows Credential Manager) via the `keyring` crate. Secrets never live in
// localStorage or any plaintext file — the OS guards them and may prompt the
// user for keychain access. The frontend keys an SSH password by
// account = "{user}@{host}:{port}". Secrets are never logged.

use keyring::Entry;

const SERVICE: &str = "com.plutothedev.terminals.ssh";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Store (or overwrite) a secret for `account`.
#[tauri::command]
pub fn secret_set(account: String, secret: String) -> Result<(), String> {
    entry(&account)?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

/// Fetch a secret. Returns None when nothing is stored (not an error).
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret. A missing entry is treated as success (idempotent).
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
