// (C)
// Keychain-backed secrets for cloud sync. The passphrase and the git PAT NEVER
// touch localStorage or the repo — only the OS keychain, via the same vault
// commands SSH creds use. Non-secret config (repo URL, enabled) lives in
// userSt.sync.
import { invoke } from "@backend";

const PASS_ACCOUNT = "sync-passphrase:v0";
const PAT_ACCOUNT = "sync-git-pat:v0";

export async function setPassphrase(p) {
  await invoke("secret_set", { account: PASS_ACCOUNT, secret: p });
}
export async function getPassphrase() {
  return (await invoke("secret_get", { account: PASS_ACCOUNT })) || null;
}
export async function setPat(p) {
  await invoke("secret_set", { account: PAT_ACCOUNT, secret: p || "" });
}
export async function getPat() {
  return (await invoke("secret_get", { account: PAT_ACCOUNT })) || null;
}
