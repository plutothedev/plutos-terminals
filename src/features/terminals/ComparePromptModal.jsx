// (C)
// Multi-model compare — type one prompt and fire it at every visible terminal at
// once (run the same task across Claude, Codex, … side by side). A one-shot
// MultiExec broadcast, without flipping permanent broadcast mode on.
import { useState } from "react";
import Modal from "../../components/Modal.jsx";

export default function ComparePromptModal({ open, targets, onSend, onClose }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    onClose();
  };
  return (
    <Modal open={open} title="Compare prompt across agents" onClose={onClose} width={560}>
      <div style={{ fontSize: 11, color: "var(--phn-text-dim, #888)", marginBottom: 8, lineHeight: 1.5 }}>
        Sends this prompt to all <strong>{targets}</strong> visible terminal{targets === 1 ? "" : "s"} at
        once — run the same task across Claude, Codex, and other agents side by side, then compare.
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        rows={5}
        placeholder="e.g. refactor the auth module and add tests"
        spellCheck={false}
        style={{
          width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 90,
          background: "var(--phn-page-bg, #1c1c1c)", border: "1px solid var(--phn-surface-border, #151515)",
          color: "var(--phn-text-fg, #d4d4d4)", borderRadius: 5, padding: "8px 10px",
          fontFamily: "var(--phn-mono-font, 'JetBrains Mono', monospace)", fontSize: 12, outline: "none",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button onClick={onClose} style={btn(false)}>cancel</button>
        <button onClick={send} disabled={!text.trim()} style={btn(!!text.trim())}>
          Send to all ({targets})  ⌘⏎
        </button>
      </div>
    </Modal>
  );
}

function btn(primary) {
  return {
    background: primary ? "var(--phn-link, #4aa8c0)" : "transparent",
    border: `1px solid ${primary ? "var(--phn-link, #4aa8c0)" : "var(--phn-surface-border, #151515)"}`,
    color: primary ? "#06223a" : "var(--phn-text-dim, #888)",
    padding: "6px 14px", borderRadius: 4, fontSize: 12, fontWeight: primary ? 600 : 400,
    cursor: primary ? "pointer" : "default", fontFamily: "var(--phn-ui-font)",
  };
}
