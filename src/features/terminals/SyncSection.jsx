// (C)
// Cloud Sync settings: repo URL + auth (PAT/SSH), dedicated passphrase, enable
// toggle, Sync now, status. Secrets go to the keychain via syncSecrets; only the
// repo URL + enabled flag persist in userSt.sync.

import { useEffect, useState } from "react";
import { Button, Input, Field } from "../../components/ui.jsx";
import { setPassphrase, setPat, getPassphrase } from "./sync/syncSecrets.js";
import { syncNow, onStatus } from "./sync/syncEngine.js";

export default function SyncSection({ userSt, saveUser }) {
  const sync = userSt?.sync || {};
  const [repoUrl, setRepoUrl] = useState(sync.repoUrl || "");
  const [pass, setPass] = useState("");
  const [pat, setPatVal] = useState("");
  const [status, setStatus] = useState({ state: "idle" });
  const [hasPass, setHasPass] = useState(false);

  useEffect(() => onStatus(setStatus), []);
  useEffect(() => { getPassphrase().then((p) => setHasPass(!!p)); }, []);

  async function enable() {
    if (pass) await setPassphrase(pass);
    if (pat) await setPat(pat);
    saveUser((prev) => ({ ...prev, sync: { ...prev.sync, repoUrl, enabled: true } }));
    setPass(""); setPatVal("");
    setHasPass(true);
    syncNow();
  }
  function disable() {
    saveUser((prev) => ({ ...prev, sync: { ...prev.sync, enabled: false } }));
  }

  const label = {
    idle: "Not synced", disabled: "Disabled", syncing: "Syncing…",
    ok: "Synced", error: "Error", "bad-passphrase": "Passphrase mismatch",
    corrupt: "Corrupt sync repo",
  }[status.state] || status.state;

  return (
    <div>
      <Field
        label="Repo URL"
        hint="A private git repository you control. Pluto stores encrypted blobs in a branch; nothing plaintext is ever pushed."
      >
        <Input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/you/pluto-sync.git"
          mono
        />
      </Field>

      <Field
        label={
          <>
            Sync passphrase
            {hasPass && <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 6 }}>(saved)</span>}
          </>
        }
        hint="Used to encrypt/decrypt sync blobs. Stored in the OS keychain — never written to disk or the repo."
      >
        <Input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={hasPass ? "•••••• (enter to change)" : "choose a passphrase"}
        />
      </Field>

      <Field
        label="Access token (HTTPS)"
        hint="A GitHub / GitLab personal access token with repo scope. Leave blank to use SSH instead. Stored in the OS keychain."
      >
        <Input
          type="password"
          value={pat}
          onChange={(e) => setPatVal(e.target.value)}
          placeholder="ghp_… (stored in keychain)"
        />
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-3)" }}>
        {sync.enabled
          ? <Button variant="ghost" onClick={disable}>Disable sync</Button>
          : <Button variant="primary" onClick={enable} disabled={!repoUrl || (!pass && !hasPass)}>Enable sync</Button>}
        <Button variant="subtle" onClick={() => syncNow()} disabled={!sync.enabled}>Sync now</Button>
        <span style={{ opacity: 0.55, fontSize: 12 }}>
          {label}{status.at ? ` · ${new Date(status.at).toLocaleTimeString()}` : ""}
        </span>
      </div>

      {status.state === "bad-passphrase" && (
        <div style={{ color: "var(--phn-danger, #e66)", fontSize: 12, marginTop: 6 }}>
          That passphrase doesn&apos;t match this sync repo.
        </div>
      )}
      {status.state === "corrupt" && (
        <div style={{ color: "var(--phn-danger, #e66)", fontSize: 12, marginTop: 6 }}>
          The remote sync blob is corrupt or truncated. Re-push from a machine whose
          data is intact (Sync now), rather than retyping the passphrase.
        </div>
      )}
      {status.state === "error" && (
        <div style={{ color: "var(--phn-danger, #e66)", fontSize: 12, marginTop: 6 }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}
