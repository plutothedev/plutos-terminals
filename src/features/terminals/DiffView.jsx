// (C)
// Diff-review modal for an agent worktree (Conductor-style diff-first review).
// Shows `git_diff` for the worktree with +/- coloring; "Create PR" pushes the
// branch and opens a GitHub PR via `gh`.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { openExternal } from "../../appMeta.js";

function lineColor(l) {
  if (l.startsWith("+++") || l.startsWith("---")) return "#9aa0a6";
  if (l.startsWith("@@")) return "#4aa8c0";
  if (l.startsWith("diff ") || l.startsWith("index ")) return "#9aa0a6";
  if (l.startsWith("+")) return "#5fd75f";
  if (l.startsWith("-")) return "#ff6b6b";
  return "var(--phn-text-fg, #d4d4d4)";
}

export default function DiffView({ open, worktree, onClose }) {
  const toast = useToast();
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

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

  const lines = (diff || "").split("\n");
  const stat = diff
    ? `${lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length} additions, ${lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length} deletions`
    : "";

  return (
    <Modal open={open} title={worktree ? `Review · ${worktree.branch}` : "Review"} onClose={onClose} width={760}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "var(--phn-text-dim, #888)" }}>{stat}</span>
        <button
          onClick={createPr}
          disabled={creating || !diff}
          style={{
            background: creating || !diff ? "transparent" : "var(--phn-link, #4aa8c0)",
            border: "1px solid var(--phn-link, #4aa8c0)",
            color: creating || !diff ? "var(--phn-text-dim, #888)" : "#06223a",
            padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
            cursor: creating || !diff ? "default" : "pointer", fontFamily: "var(--phn-ui-font)",
          }}
        >
          {creating ? "Creating PR…" : "Create PR ↗"}
        </button>
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
