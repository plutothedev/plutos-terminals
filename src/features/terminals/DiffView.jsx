// (C)
// Diff-review modal for an agent worktree (Conductor-style diff-first review).
// Shows `git_diff` for the worktree with +/- coloring; "Create PR" pushes the
// branch and opens a GitHub PR via `gh`.
import { useEffect, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";
import { openExternal } from "../../appMeta.js";

function lineColor(l) {
  if (l.startsWith("+++") || l.startsWith("---")) return "#9aa0a6";
  if (l.startsWith("@@")) return "#7c9cf5";
  if (l.startsWith("diff ") || l.startsWith("index ")) return "#9aa0a6";
  if (l.startsWith("+")) return "#7fbf8a";
  if (l.startsWith("-")) return "#ff6b6b";
  return "var(--phn-text-fg, #d4d4d4)";
}

export default function DiffView({ open, worktree, onClose, onDiscard }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    if (!open || !worktree?.path) return;
    let alive = true;
    setLoading(true); setError(null); setDiff(null);
    invoke("git_diff", { path: worktree.path })
      .then((d) => { if (alive) setDiff(typeof d === "string" ? d : ""); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, worktree]);

  const createPr = async () => {
    if (!worktree?.path) return;
    setCreating(true);
    try {
      const url = await invoke("gh_pr_create", { path: worktree.path });
      toast.success("PR created.");
      if (url && /^https?:\/\//.test(url)) openExternal(url);
    } catch (e) {
      toast.error(`PR failed: ${e}`);
    } finally {
      setCreating(false);
    }
  };

  // Permanently delete the worktree folder (and any uncommitted work). The
  // parent closes the owning agent tab first so its shell releases the folder,
  // then runs the git removal — see discardWorktree in TerminalsTab.
  const discard = async () => {
    if (!worktree?.path || !onDiscard) return;
    const ok = await confirm(
      `Discard the worktree for "${worktree.branch}"? This permanently deletes the folder and any uncommitted changes on that branch, and closes its agent tab.`,
      { title: "Discard worktree?", confirmLabel: "discard", destructive: true }
    );
    if (!ok) return;
    setDiscarding(true);
    try { await onDiscard(worktree); }
    finally { setDiscarding(false); }
  };

  const lines = (diff || "").split("\n");
  const stat = diff
    ? `${lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length} additions, ${lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length} deletions`
    : "";

  return (
    <Modal
      open={open}
      title={worktree ? `Review · ${worktree.branch}` : "Review"}
      // Block Escape / backdrop / × while a discard is mid-retry (~2.5s) so the
      // user can't dismiss the modal and then get a stray toast from the
      // still-running removal. Re-enabled the moment discarding settles.
      onClose={discarding ? () => {} : onClose}
      width={760}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "var(--phn-text-dim, #888)" }}>{stat}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {onDiscard && (
            <button
              onClick={discard}
              disabled={discarding || creating}
              title="Delete this worktree folder and close its agent tab"
              style={{
                background: "transparent",
                border: "1px solid var(--phn-danger, #e08784)",
                color: "var(--phn-danger, #e08784)",
                padding: "5px 12px", borderRadius: 4, fontSize: 12, fontWeight: 600,
                cursor: discarding || creating ? "default" : "pointer",
                opacity: discarding || creating ? 0.6 : 1, fontFamily: "var(--phn-ui-font)",
              }}
            >
              {discarding ? "Discarding…" : "Discard worktree"}
            </button>
          )}
          <button
            onClick={createPr}
            disabled={creating || discarding || !diff}
            style={{
              background: creating || discarding || !diff ? "transparent" : "var(--phn-link, #7c9cf5)",
              border: "1px solid var(--phn-link, #7c9cf5)",
              color: creating || discarding || !diff ? "var(--phn-text-dim, #888)" : "#06223a",
              padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
              cursor: creating || discarding || !diff ? "default" : "pointer", fontFamily: "var(--phn-ui-font)",
            }}
          >
            {creating ? "Creating PR…" : "Create PR ↗"}
          </button>
        </div>
      </div>
      <div
        style={{
          maxHeight: "62vh", overflow: "auto",
          background: "var(--phn-page-bg, #1c1c1c)",
          border: "1px solid var(--phn-surface-border, #151515)",
          borderRadius: 6, padding: "8px 10px",
          fontFamily: "'MesloLGS NF', 'JetBrains Mono', Menlo, monospace",
          fontSize: 12, lineHeight: 1.45, whiteSpace: "pre",
        }}
      >
        {loading ? (
          <div style={{ color: "var(--phn-text-dim, #888)" }}>Loading diff…</div>
        ) : error ? (
          <div style={{ color: "#ff6b6b" }}>{error}</div>
        ) : !diff || !diff.trim() ? (
          <div style={{ color: "var(--phn-text-dim, #888)" }}>No changes yet on this worktree.</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} style={{ color: lineColor(l), minHeight: "1.2em" }}>{l || " "}</div>
          ))
        )}
      </div>
    </Modal>
  );
}
