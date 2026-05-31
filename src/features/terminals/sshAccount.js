// (C)
// Keychain account key for an SSH connection's saved password (vault.rs keys
// under a fixed service; this is the per-host/user account). Shared by
// TerminalsTab's credential callbacks and the extracted session/tunnel hooks so
// the key format ("user@host:port") is defined in exactly one place.
export function sshAccount(conn) {
  return `${conn.user}@${conn.host}:${conn.port || 22}`;
}
