// (C)
// Stream D: "My shares" is the machine-local list of gists this machine created
// through the ShareModal, with per-row Open (browser) and Revoke (delete the
// gist, drop the entry). shareHistory lives in userSt.shareHistory and is
// deliberately NOT synced (see sync/syncState.js): a gist created on one machine
// is only listed and revocable where it was made. Mirrors WorkspacesModal's
// list-with-per-item-actions shape (inline confirm before the destructive act).
import { useEffect, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { Button } from "../../components/ui.jsx";
import { useToast } from "../../components/Toast.jsx";
import { openExternal } from "../../appMeta.js";
import { visibleShares, SHARES_PAGE_SIZE } from "./sharesPage.js";

const DIM = "var(--phn-text-dim, #888)";

export default function SharesModal({ open, shareHistory, onClose, saveUser }) {
  const toast = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(null); // id awaiting revoke confirmation
  const [revoking, setRevoking] = useState(null); // id currently in-flight
  const [shown, setShown] = useState(SHARES_PAGE_SIZE); // pagination cap (resets on open)

  useEffect(() => { if (open) { setConfirmRevoke(null); setRevoking(null); setShown(SHARES_PAGE_SIZE); } }, [open]);

  // Storage stays append-order; display is newest-first + capped (sharesPage.js).
  const { rows, remaining } = visibleShares(shareHistory, shown);

  const revoke = async (entry) => {
    if (revoking) return;
    setRevoking(entry.id);
    try {
      // The gist DELETE. 404 (already gone) is treated as success Rust-side, so
      // a stale entry still clears from the list.
      await invoke("gist_delete", { id: entry.id });
      // Drop the entry via functional saveUser so a concurrent write (e.g. a new
      // share appending) can't clobber a just-removed one with a stale snapshot.
      saveUser?.((prev) => ({ ...prev, shareHistory: (prev?.shareHistory || []).filter((e) => e.id !== entry.id) }));
      toast.success("Gist revoked");
      setConfirmRevoke(null);
    } catch (e) {
      // Already Rust-redacted (share.rs redact()) before crossing IPC, so no
      // token or Authorization bytes can ride this string to the toast.
      toast.error(String(e));
      // Spec'd durable marker (release-audit fix): a 4s toast is the only
      // signal otherwise — once it fades, a failed revoke is indistinguishable
      // from a never-revoked share, and the gist is still live on GitHub.
      saveUser?.((prev) => ({
        ...prev,
        shareHistory: (prev?.shareHistory || []).map((s) =>
          s.id === entry.id ? { ...s, deleteFailed: true } : s
        ),
      }));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Modal open={open} title="My shares" onClose={onClose} width={560}>
      <div style={{ maxHeight: "55vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--phn-sp-2)" }}>
        {rows.length === 0 && remaining === 0 ? (
          <div style={{ color: DIM, fontSize: "var(--phn-fs-sm)", padding: "var(--phn-sp-3) 2px" }}>
            No shares yet. Right-click a command block or a tab to share it.
          </div>
        ) : (
          rows.map((s) => (
            <div key={s.id} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--phn-fs-sm)", color: "var(--phn-text-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.title || "(untitled)"}
                </div>
                <div style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ color: s.public ? "var(--phn-warning)" : DIM }}>{s.public ? "Public" : "Secret"}</span>
                  {s.date ? ` · ${s.date}` : ""}
                  {s.htmlUrl ? ` · ${s.htmlUrl}` : ""}
                </div>
                {s.deleteFailed && (
                  <div style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-danger, #e08784)", whiteSpace: "nowrap" }}>
                    delete failed — still live; retry revoke or remove it on GitHub
                  </div>
                )}
              </div>
              {confirmRevoke === s.id ? (
                <>
                  <span style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-warning)", whiteSpace: "nowrap" }}>delete this gist?</span>
                  <Button variant="danger" size="sm" disabled={revoking === s.id} onClick={() => revoke(s)}>
                    {revoking === s.id ? "revoking…" : "yes, revoke"}
                  </Button>
                  <Button variant="subtle" size="sm" disabled={revoking === s.id} onClick={() => setConfirmRevoke(null)}>no</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openExternal(s.htmlUrl)} disabled={!s.htmlUrl} title="Open the gist in your browser">open</Button>
                  <Button variant="subtle" size="sm" onClick={() => setConfirmRevoke(s.id)} title="Revoke (delete) this gist">revoke</Button>
                </>
              )}
            </div>
          ))
        )}
        {remaining > 0 && (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => setShown((n) => n + SHARES_PAGE_SIZE)}
            title="Older shares are hidden to keep this list fast"
          >
            show {Math.min(SHARES_PAGE_SIZE, remaining)} more ({remaining} older hidden)
          </Button>
        )}
      </div>

      <p style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)" }}>
        This list is kept on this machine only and does not sync. Revoking deletes the gist from GitHub, so the link stops working for anyone who has it.
      </p>
    </Modal>
  );
}

const row = {
  display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "7px var(--phn-sp-3)", borderRadius: "var(--phn-r-md)",
  background: "var(--phn-surface-bg, #242424)", border: "1px solid var(--phn-surface-border, #2a2a2a)",
};
