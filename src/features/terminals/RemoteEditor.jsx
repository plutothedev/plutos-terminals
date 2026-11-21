// (C)
// In-app remote file editor (MobaXterm/Termius parity). Opens a remote file over
// the active SFTP session, edits it, and saves back — no local round trip.
// Monaco is loaded DYNAMICALLY on first open (never at app startup) so its heavy
// bundle + web workers can't blank the app if they misbehave in the webview;
// if the dynamic load fails we fall back to a plain textarea. Cmd/Ctrl+S saves.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";
import { markRemoteEditDirty, clearRemoteEditDirty } from "./remoteEditDirty.js";
import { modCombo } from "./keybindings.js";
import { humanizeError } from "./errorText.js";

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
  const [Editor, setEditor] = useState(null);   // Monaco component once loaded
  const [monacoFailed, setMonacoFailed] = useState(false);

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

  // One editing session per (session, file): keyed so opening another file, or
  // reopening after a close, mounts a fresh buffer (empty text, loading state)
  // instead of an effect resetting four states on every change. Monaco itself
  // stays loaded here, across sessions.
  if (!open) return null;
  return (
    <RemoteEditorSession
      key={`${sessionId}:${path}`}
      sessionId={sessionId}
      path={path}
      name={name}
      onClose={onClose}
      Editor={Editor}
      monacoFailed={monacoFailed}
    />
  );
}

function RemoteEditorSession({ sessionId, path, name, onClose, Editor, monacoFailed }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  // Starts true when there is something to fetch, so the first paint is already
  // the loading state and the fetch effect below sets no state synchronously.
  const [loading, setLoading] = useState(!!(sessionId && path));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // The save mutex. `saving` drives the UI; this ref is what save() checks, so
  // a second Ctrl+S during a slow write is refused even before the re-render
  // that would show "Saving…" has committed.
  const savingRef = useRef(false);
  // The buffer the in-flight save is writing (null when none is). Close
  // compares it with the current text: only edits that save covers may skip
  // the discard confirm.
  const inFlightRef = useRef(null);
  // That save's promise (true = written, false = failed), for a close that
  // waits on it. Null when no save is in flight.
  const inFlightDoneRef = useRef(null);
  const textRef = useRef("");
  // Latest buffer for save(), written after every commit and read from handlers.
  useLayoutEffect(() => { textRef.current = text; });

  useEffect(() => {
    if (!sessionId || !path) return;
    let alive = true;
    invoke("sftp_read_file", { id: sessionId, path })
      .then((c) => { if (alive) { const s = typeof c === "string" ? c : ""; setText(s); setOrig(s); } })
      .catch((e) => { if (alive) setError(humanizeError(e, "Couldn't open the file").message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, path]);

  const dirty = text !== orig;

  // Publish dirtiness to the module registry so tab-close paths (which unmount
  // this editor without hitting its own onClose guard) can confirm first (audit
  // C4). Keyed by session+path; cleared when the buffer is clean and when this
  // session unmounts. This component only exists while the editor is open (the
  // outer RemoteEditor returns null when closed), so a discard-close unmounts it
  // and the cleanup clears the key: no phantom "<session>:undefined" entry can
  // be left marked to confirm every later tab-close app-wide (the regression
  // the old `open` gate guarded against).
  useEffect(() => {
    const key = `${sessionId}:${path}`;
    if (dirty) markRemoteEditDirty(key);
    else clearRemoteEditDirty(key);
    return () => clearRemoteEditDirty(key);
  }, [dirty, sessionId, path]);

  // A promise chain rather than async/await: the mutex is taken here and
  // released in the chain's finally, the only two writers of savingRef.
  //
  // Nothing to save while the file is still loading or failed to load: the
  // buffer is the empty placeholder then, and writing it would replace the
  // remote file with an empty one. Nor when the buffer is clean, which is
  // what the Save button already says by being disabled.
  const save = () => {
    if (savingRef.current || !sessionId || !path) return undefined;
    if (loading || error || !dirty) return undefined;
    savingRef.current = true;
    setSaving(true);
    // Snapshot the buffer at call time; re-reading textRef after the write
    // would mark keystrokes typed during a slow save as already-saved and lose
    // them.
    const snapshot = textRef.current;
    inFlightRef.current = snapshot;
    // new Promise(...) so a synchronous throw from invoke is still caught below.
    // Settles to true when the write landed, false when it failed, so a close
    // waiting on this save knows which way it went.
    const done = new Promise((resolve) => resolve(invoke("sftp_write_file", { id: sessionId, path, content: snapshot })))
      .then(() => {
        setOrig(snapshot);
        toast.success(`Saved ${name}`);
        return true;
      })
      .catch((e) => {
        toast.error(humanizeError(e, "Save failed"));
        return false;
      })
      .finally(() => {
        savingRef.current = false;
        inFlightRef.current = null;
        inFlightDoneRef.current = null;
        setSaving(false);
      });
    inFlightDoneRef.current = done;
    return done;
  };
  // Latest save() for the window key listener, which is registered once per
  // session: the listener reads this ref instead of a closure from the render
  // that registered it.
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Never discard unsaved edits silently (audit C4): Escape / backdrop / ✕ all
  // route through Modal's onClose, so gate it behind a confirm when dirty. A
  // save in flight excuses the confirm only when it is writing exactly the
  // text on screen; keystrokes typed after its snapshot are not covered by it.
  // Even then the close waits for that save: on success it closes; on failure
  // the editor stays open with the text (the error toast says why), and the
  // next close finds the buffer dirty with no save in flight, so it asks.
  // While it waits, the Save button already reads "Saving…".
  const askDiscard = () => confirm(
    `"${name}" has unsaved changes. Close and discard them?`,
    { title: "Discard changes?", confirmLabel: "Discard", destructive: true }
  );
  const requestClose = async () => {
    const coveredText = textRef.current;
    const covered = savingRef.current && inFlightRef.current === coveredText;
    if (covered) {
      const saved = await inFlightDoneRef.current;
      if (!saved) return;
      // Keystrokes typed while the close waited are not in that save.
      if (textRef.current !== coveredText && !(await askDiscard())) return;
      onClose();
      return;
    }
    if (dirty && !(await askDiscard())) return;
    onClose();
  };

  const useMonaco = Editor && !monacoFailed;

  return (
    <Modal open title={`${dirty ? "● " : ""}${name}`} onClose={requestClose} width={860}>
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
          {saving ? "Saving…" : dirty ? `Save (${modCombo("S")})` : "Saved"}
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
