// (C)
// In-app remote file editor (MobaXterm/Termius parity). Opens a remote file over
// the active SFTP session in a Monaco editor and saves it back — no local round
// trip. Cmd/Ctrl+S saves; the title shows a dirty dot. If Monaco fails to load
// in the webview it falls back to a plain textarea so editing still works.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Editor from "@monaco-editor/react";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { languageForFile } from "./monacoSetup.js";

export default function RemoteEditor({ open, sessionId, path, name, onClose }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [monacoFailed, setMonacoFailed] = useState(false);
  const textRef = useRef("");
  textRef.current = text;

  useEffect(() => {
    if (!open || !sessionId || !path) return;
    let alive = true;
    setLoading(true); setError(null); setText(""); setOrig("");
    invoke("sftp_read_file", { id: sessionId, path })
      .then((c) => { if (alive) { const s = typeof c === "string" ? c : ""; setText(s); setOrig(s); } })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, sessionId, path]);

  const dirty = text !== orig;

  const save = async () => {
    if (saving || !sessionId || !path) return;
    setSaving(true);
    try {
      await invoke("sftp_write_file", { id: sessionId, path, content: textRef.current });
      setOrig(textRef.current);
      toast.success(`Saved ${name}`);
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+S anywhere in the modal saves.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, name, sessionId, path]); // eslint-disable-line

  if (!open) return null;

  return (
    <Modal open={open} title={`${dirty ? "● " : ""}${name}`} onClose={onClose} width={860}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10.5, color: "var(--phn-text-dim, #888)", fontFamily: "'MesloLGS NF', monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>{path}</span>
        <button
          onClick={save}
          disabled={saving || !dirty || loading || !!error}
          style={{
            background: saving || !dirty ? "transparent" : "var(--phn-link, #4aa8c0)",
            border: "1px solid var(--phn-link, #4aa8c0)",
            color: saving || !dirty ? "var(--phn-text-dim, #888)" : "#06223a",
            padding: "4px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
            cursor: saving || !dirty ? "default" : "pointer", fontFamily: "var(--phn-ui-font)",
          }}
        >
          {saving ? "Saving…" : dirty ? "Save (⌘S)" : "Saved"}
        </button>
      </div>

      <div style={{ height: "60vh", border: "1px solid var(--phn-surface-border, #151515)", borderRadius: 6, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 16, color: "var(--phn-text-dim, #888)", fontSize: 12 }}>Loading {name}…</div>
        ) : error ? (
          <div style={{ padding: 16, color: "#ff6b6b", fontSize: 12 }}>{error}</div>
        ) : monacoFailed ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%", height: "100%", boxSizing: "border-box", resize: "none",
              background: "var(--phn-page-bg, #1c1c1c)", color: "var(--phn-text-fg, #d4d4d4)",
              border: "none", outline: "none", padding: 10,
              fontFamily: "'MesloLGS NF', 'JetBrains Mono', monospace", fontSize: 13, lineHeight: 1.5,
            }}
          />
        ) : (
          <Editor
            height="100%"
            theme="vs-dark"
            language={languageForFile(name)}
            value={text}
            onChange={(v) => setText(v ?? "")}
            onValidate={() => {}}
            loading={<div style={{ padding: 16, color: "var(--phn-text-dim, #888)", fontSize: 12 }}>Starting editor…</div>}
            onMount={() => { /* loaded ok */ }}
            beforeMount={(m) => { if (!m) setMonacoFailed(true); }}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, fontFamily: "'MesloLGS NF', 'JetBrains Mono', monospace" }}
          />
        )}
      </div>
    </Modal>
  );
}
