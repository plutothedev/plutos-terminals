// (C)
// Settings > Sharing: a gist-scope GitHub token for the block/transcript share
// flow (Stream D). The token goes straight to the OS keychain via secret_set
// under the dedicated account "github-gist-pat:v0", NOT the repo-scope
// sync-git-pat:v0 the cloud-sync feature uses, and never into userSt. If the gh
// CLI is already authed, no token is needed here (gh wins). Mirrors SyncSection's
// PAT field: a masked input, a status line, and a clear button.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@backend";
import { Button, Input, Field } from "../../components/ui.jsx";
import { useToast } from "../../components/Toast.jsx";
import { humanizeError } from "./errorText.js";

const GIST_PAT_ACCOUNT = "github-gist-pat:v0";

// gist_auth_available returns source: "gh" | "pat" | "none". Map each to a plain
// status label (the fixed backend `detail` strings are not reused here so the
// wording stays a UI concern).
const STATUS_LABEL = {
  gh: "Using gh CLI",
  pat: "Using saved token",
  none: "Not connected",
};

export default function SharingSection() {
  const toast = useToast();
  const [pat, setPat] = useState("");
  const [source, setSource] = useState(null); // "gh" | "pat" | "none" | null (still checking)
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const auth = await invoke("gist_auth_available");
      setSource(auth?.source || "none");
    } catch {
      setSource("none");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const saveToken = async () => {
    const secret = pat.trim();
    if (!secret || busy) return;
    setBusy(true);
    try {
      await invoke("secret_set", { account: GIST_PAT_ACCOUNT, secret });
      setPat("");
      toast.success("Gist token saved");
      await refresh();
    } catch (e) {
      toast.error(humanizeError(e, "Couldn't save token"));
    } finally {
      setBusy(false);
    }
  };

  const clearToken = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("secret_delete", { account: GIST_PAT_ACCOUNT });
      toast.info("Gist token cleared");
      await refresh();
    } catch (e) {
      toast.error(humanizeError(e, "Couldn't clear token"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Field
        label="GitHub gist token"
        hint="A personal access token with the gist scope. Used only to create the gists that back Share block and Share transcript. Stored in the OS keychain, never in the synced settings. Leave this blank if you use the gh CLI (gh auth login), which takes priority."
      >
        <Input
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") saveToken(); }}
          placeholder="ghp_… (stored in keychain)"
        />
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-3)" }}>
        <Button variant="primary" onClick={saveToken} disabled={!pat.trim() || busy}>Save token</Button>
        <Button variant="subtle" onClick={clearToken} disabled={busy}>Clear token</Button>
        <span style={{ opacity: 0.55, fontSize: 12 }}>
          {source ? (STATUS_LABEL[source] || "Not connected") : "Checking…"}
        </span>
      </div>
    </div>
  );
}
