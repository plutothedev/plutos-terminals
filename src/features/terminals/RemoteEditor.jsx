// (C)
// In-app remote file editor (MobaXterm/Termius parity). Opens a remote file over
// the active SFTP session, edits it, and saves back — no local round trip.
// Monaco is loaded DYNAMICALLY on first open (never at app startup) so its heavy
// bundle + web workers can't blank the app if they misbehave in the webview;
// if the dynamic load fails we fall back to a plain textarea. Cmd/Ctrl+S saves.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";

// Local filename→language guess (kept here so Monaco isn't imported eagerly).
function languageForFile(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", css: "css", scss: "scss", less: "less", html: "html", xml: "xml", svg: "xml",
    md: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", sh: "shell", bash: "shell", zsh: "shell",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", sql: "sql", php: "php", lua: "lua",
  };
  return map[ext] || "plaintext";
}

export default function RemoteEditor({ open, sessionId, path, name, onClose }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [Editor, setEditor] = useState(null);   // Monaco component once loaded
  const [monacoFailed, setMonacoFailed] = useState(false);
  const textRef = useRef("");
  textRef.current = text;

  // Lazy-load Monaco the first time the editor opens; fall back to a textarea.
  useEffect(() => {
    if (!open || Editor || monacoFailed) return;
    let alive = true;
    (async () => {
      try {
        await import("./monacoSetup.js"); // side effects: local monaco + workers
        const mod = await import("@monaco-editor/react");
        if (alive) setEditor(() => mod.default);
      } catch {
        if (alive) setMonacoFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [open, Editor, monacoFailed]);

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
    // Snapshot the buffer at call time; re-reading textRef AFTER the await would
    // mark keystrokes typed during a slow save as already-saved and lose them.
    const snapshot = textRef.current;
    try {
      await invoke("sftp_write_file", { id: sessionId, path, content: snapshot });
      setOrig(snapshot);
      toast.success(`Saved ${name}`);
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, name, sessionId, path]); // eslint-disable-line

  if (!open) return null;

  const useMonaco = Editor && !monacoFailed;

  return (
    <Modal open={open} title={`${dirty ? "● " : ""}${name}`} onClose={onClose} width={860}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10.5, color: "var(--phn-text-dim, #888)", fontFamily: "'MesloLGS NF', monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>{path}</span>
        <button
          onClick={save}
          disabled={saving || !dirty || loading || !!error}
          style={{
            background: saving || !dirty ? "transparent" : "var(--phn-link, #7c9cf5)",
            border: "1px solid var(--phn-link, #7c9cf5)",
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
          <div style={{ padding: 16, color: "var(--phn-danger, #ff6b6b)", fontSize: 12 }}>{error}</div>
        ) : useMonaco ? (
          <Editor
            height="100%"
            theme="vs-dark"
            language={languageForFile(name)}
            value={text}
            onChange={(v) => setText(v ?? "")}
            loading={<div style={{ padding: 16, color: "var(--phn-text-dim, #888)", fontSize: 12 }}>Starting editor…</div>}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, fontFamily: "'MesloLGS NF', 'JetBrains Mono', monospace" }}
          />
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={monacoFailed ? "" : "Loading editor…"}
            style={{
              width: "100%", height: "100%", boxSizing: "border-box", resize: "none",
              background: "var(--phn-page-bg, #1c1c1c)", color: "var(--phn-text-fg, #d4d4d4)",
              border: "none", outline: "none", padding: 10,
              fontFamily: "'MesloLGS NF', 'JetBrains Mono', monospace", fontSize: 13, lineHeight: 1.5,
            }}
          />
        )}
      </div>
    </Modal>
  );
}
