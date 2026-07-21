// (C)
// Notebook tab view — STUB for Task C-3 (Task C-4 replaces this with the full
// lazy-Monaco editor + Run rail). Reads the notebook file on mount and renders
// the raw markdown text in a <pre>. A read failure (no file yet, OR a name the
// Rust dir-scope gate rejects) is shown as a "new notebook" seed line rather
// than a blank/broken pane — telling a genuinely-missing-after-restore file
// apart from brand-new is C-4's job (warning banner), not this stub's.
import { useEffect, useState } from "react";
import { invoke } from "@backend";

export default function NotebookView({ name, tabId, visible }) {
  const [content, setContent] = useState(null); // null = loading
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setIsNew(false);
    invoke("notebook_read", { name })
      .then((text) => { if (alive) setContent(text); })
      .catch(() => {
        if (!alive) return;
        setIsNew(true);
        setContent("");
      });
    return () => { alive = false; };
  }, [name]);

  const seed = `# ${String(name || "").replace(/\.md$/i, "")}\n\nStart writing here. Add a shell code block (sh/bash/powershell/pwsh/cmd) to make it runnable — the run rail lands in a later build.\n`;

  return (
    <div
      data-tab-id={tabId}
      data-notebook-visible={visible ? "1" : "0"}
      style={{
        width: "100%",
        height: "100%",
        overflow: "auto",
        boxSizing: "border-box",
        background: "var(--phn-page-bg, #0a0a0a)",
        color: "var(--phn-text-fg, #9D9D9D)",
      }}
    >
      <div
        style={{
          padding: "6px 16px",
          fontSize: 11,
          color: "var(--phn-text-faint, #586068)",
          fontFamily: "var(--phn-ui-font, inherit)",
          borderBottom: "1px solid var(--phn-surface-border, rgba(255,255,255,0.08))",
        }}
      >
        {name}
        {isNew ? " — new notebook (nothing saved yet)" : ""}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 16,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
          fontSize: 13,
          lineHeight: 1.6,
          color: "var(--phn-text-active, #E6E6E6)",
        }}
      >
        {content == null ? "Loading…" : (content || seed)}
      </pre>
    </div>
  );
}
