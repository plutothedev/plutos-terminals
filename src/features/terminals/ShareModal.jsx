// (C)
// Stream D: bespoke share-preview modal built on Modal.jsx.
//
// THE load-bearing invariant of the whole share stream: buildShare() runs ONCE
// per open (useMemo, keyed on the inputs), and the SAME memoized `masked` string
// is threaded into BOTH the preview <pre> the user reads AND the gist_create()
// upload. rawText and title are NEVER sent to the gist: the upload content is
// `masked`, the upload filename is buildShare's fixed, content-independent
// scheme (Task D-3), and `title` is header/display text only. The gist POST is
// reachable ONLY from the explicit Share button below — there is no auto-share.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@backend";
import Modal, { MODAL_COLORS } from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { buildShare } from "./shareText.js";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;
const DANGER = "var(--phn-danger, #e08784)";

// Aggregate hits by their type NAME (never the matched value) for the warning
// row — "provider-key ×2", "aws-access-key". Only the masked <pre> is ever
// shown or uploaded; a secret's actual bytes never reach this modal's DOM.
function secretNameCounts(hits) {
  const counts = new Map();
  for (const h of hits) counts.set(h.name, (counts.get(h.name) || 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}

// `userSt` is accepted for the shared-modal contract (the sibling D-5 "My shares"
// list reads userSt.shareHistory through this same prop channel). D-4's own
// success path appends via the functional saveUser(prev) form below, which is
// race-safe and needs no snapshot, so userSt is not read here.
export default function ShareModal({ open, kind, title, rawText, dateStamp, onClose, saveUser, userSt }) {
  const toast = useToast();
  const [isPublic, setIsPublic] = useState(false); // default: SECRET / unlisted ("public" is a reserved word in strict-mode JS)
  const [submitting, setSubmitting] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);

  // Reset per-open so a prior "public" choice / in-flight flag / auth notice
  // never carries into the next share. Correct whether the modal is
  // conditionally mounted (D-4) or kept mounted with a toggling `open` (D-5).
  useEffect(() => {
    if (open) { setIsPublic(false); setSubmitting(false); setNeedsAuth(false); }
  }, [open]);

  // LOAD-BEARING: compute ONCE per open. The exact `masked` rendered below is
  // the exact `masked` uploaded — never re-derived, never rawText, never title.
  const { filename, masked, hits } = useMemo(
    () => buildShare(kind, rawText, dateStamp),
    [kind, rawText, dateStamp]
  );
  const hasSecrets = hits.length > 0;

  const doShare = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const auth = await invoke("gist_auth_available");
      if (!auth || auth.source === "none") {
        // No GitHub token → surface the connect-GitHub state; do NOT create a
        // gist. The POST is never reached without a resolvable token.
        setNeedsAuth(true);
        setSubmitting(false);
        return;
      }
      setNeedsAuth(false);
      // The ONLY gist POST in the app. Uploads the memoized `masked` + the fixed
      // content-independent filename from buildShare — nothing else. `title`
      // (the raw command) and `rawText` (unmasked) are never sent.
      const res = await invoke("gist_create", { filename, content: masked, public: isPublic });
      try { await navigator.clipboard?.writeText(res.htmlUrl); } catch { /* clipboard is best-effort */ }
      toast.success("Gist created, URL copied");
      const entry = { id: res.id, url: res.url, htmlUrl: res.htmlUrl, title, date: dateStamp, public: isPublic };
      // Machine-local history (NOT synced — see D-5). Functional form so a
      // concurrent saveUser can't clobber a just-appended entry.
      saveUser?.((prev) => ({ ...prev, shareHistory: [...(prev?.shareHistory || []), entry] }));
      onClose();
    } catch (e) {
      // `e` is already redacted Rust-side (share.rs redact()) before it crosses
      // the IPC boundary — no token/Authorization bytes can ride it to the toast.
      toast.error(String(e));
      setSubmitting(false);
    }
  };

  const btnLabel = submitting ? "Sharing…" : hasSecrets ? "Share anyway" : "Share";
  const primaryBg = submitting ? "var(--phn-surface-border, #2b2b2b)" : ACCENT;

  return (
    <Modal
      open={open}
      title={`Share ${kind === "transcript" ? "transcript" : "block"}`}
      onClose={onClose}
      width={620}
    >
      {/* Display-only: what's being shared (the block command / tab label). Never uploaded. */}
      <div style={{ color: FG_DIM, fontSize: 11, marginBottom: 12, fontFamily: M, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title ? `Sharing: ${title}` : "Sharing"}
      </div>

      <div style={{ color: FG_ACTIVE, fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
        What leaves your machine
      </div>
      <div style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.5, marginBottom: 8 }}>
        The text below is uploaded to a GitHub gist as{" "}
        <code style={{ fontFamily: M, color: FG }}>{filename}</code>. Detected secrets are masked.
        The original unmasked text and the command title are never sent.
      </div>

      {/* THE upload, verbatim. This exact string is what gist_create receives. */}
      <pre style={{
        margin: 0, maxHeight: 260, overflow: "auto",
        background: "var(--phn-page-bg, #0a0a0a)", border: `1px solid ${BORDER}`,
        borderRadius: 4, padding: "10px 12px", fontSize: 12, lineHeight: 1.45,
        fontFamily: M, color: FG_ACTIVE, whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {masked}
      </pre>

      {hasSecrets && (
        <div style={{
          marginTop: 10, padding: "8px 12px", borderRadius: 4,
          background: "rgba(224,135,132,0.12)", border: `1px solid ${DANGER}`,
          color: DANGER, fontSize: 11, lineHeight: 1.5, fontFamily: M,
        }}>
          <strong>{hits.length} secret{hits.length > 1 ? "s" : ""} masked</strong> in the upload above:{" "}
          {secretNameCounts(hits).join(", ")}. The values are hidden. The masked text above is exactly what uploads.
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: FG, fontSize: 12, marginBottom: 6, cursor: "pointer" }}>
          <input type="radio" name="share-visibility" checked={!isPublic} onChange={() => setIsPublic(false)} />
          Secret (unlisted)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: FG, fontSize: 12, cursor: "pointer" }}>
          <input type="radio" name="share-visibility" checked={isPublic} onChange={() => setIsPublic(true)} />
          Public
        </label>
        <div style={{ color: FG_DIM, fontSize: 10.5, lineHeight: 1.5, marginTop: 6 }}>
          Secret gists aren't private. Anyone with the link can view them until you revoke.
        </div>
      </div>

      {needsAuth && (
        <div style={{
          marginTop: 14, padding: "8px 12px", borderRadius: 4,
          background: "rgba(124,156,245,0.10)", border: `1px solid ${ACCENT}`,
          color: FG_ACTIVE, fontSize: 11, lineHeight: 1.5,
        }}>
          <strong>Connect GitHub to share.</strong> Add a gist-scope token in Settings → Sharing, or run{" "}
          <code style={{ fontFamily: M }}>gh auth login</code> in a terminal, then try again.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button
          onClick={onClose}
          style={{
            background: "transparent", border: `1px solid ${BORDER}`, color: FG,
            padding: "6px 16px", borderRadius: 3, fontFamily: M, fontSize: 11, cursor: "pointer",
          }}
        >
          cancel
        </button>
        <button
          onClick={doShare}
          disabled={submitting}
          style={{
            background: primaryBg, border: `1px solid ${primaryBg}`, color: "#001",
            padding: "6px 16px", borderRadius: 3, fontFamily: M, fontSize: 11, fontWeight: 600,
            cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1,
          }}
        >
          {btnLabel}
        </button>
      </div>
    </Modal>
  );
}
