// (C)
// Remote file browser (SFTP over the live ssh2 connection). Opened for the
// active SSH tab — the parent (TerminalsTab) calls sftp_connect and passes the
// session id. Navigate dirs, download/upload, mkdir, rename, delete. Transfers
// run entirely in Rust (rfd dialogs pick local paths); this UI only drives them.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";
import { fileGlyph } from "./LocalFileBrowser.jsx";
import { IconHome, IconUp, IconRefresh, IconUpload, IconNewFolder } from "./icons.jsx";
import RemoteEditor from "./RemoteEditor.jsx";
import "./terminals.css";

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function parentPath(p) {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return "/";
  return trimmed.slice(0, i);
}

function joinPath(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export default function SftpBrowser({ open, connecting, error, sessionId, onClose, docked = false }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [cwd, setCwd] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [editTarget, setEditTarget] = useState(null); // remote file open in the editor

  const list = useCallback(async (path) => {
    if (!sessionId) return;
    setLoading(true);
    setListError(null);
    try {
      const items = await invoke("sftp_list", { id: sessionId, path });
      setEntries(Array.isArray(items) ? items : []);
      setCwd(path);
    } catch (e) {
      setListError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // When a session connects, resolve the home dir and list it.
  useEffect(() => {
    if ((!open && !docked) || !sessionId) return;
    let alive = true;
    (async () => {
      try {
        const home = await invoke("sftp_home", { id: sessionId });
        if (alive) await list(home || "/");
      } catch (e) {
        if (alive) setListError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [open, docked, sessionId, list]);

  const refresh = useCallback(() => { if (cwd) list(cwd); }, [cwd, list]);
  const goHome = useCallback(async () => {
    if (!sessionId) return;
    try { const home = await invoke("sftp_home", { id: sessionId }); await list(home || "/"); }
    catch (e) { setListError(String(e)); }
  }, [sessionId, list]);

  const onDownload = async (entry) => {
    try {
      const saved = await invoke("sftp_download", { id: sessionId, path: entry.path });
      if (saved) toast.success(`Downloaded → ${saved}`);
    } catch (e) {
      toast.error(`Download failed: ${e}`);
    }
  };

  const onUpload = async () => {
    if (!cwd) return;
    try {
      const remote = await invoke("sftp_upload", { id: sessionId, dir: cwd });
      if (remote) {
        toast.success(`Uploaded → ${remote}`);
        refresh();
      }
    } catch (e) {
      toast.error(`Upload failed: ${e}`);
    }
  };

  const onMkdir = async () => {
    if (!cwd) return;
    const name = window.prompt("New folder name?");
    if (!name || !name.trim()) return;
    try {
      await invoke("sftp_mkdir", { id: sessionId, path: joinPath(cwd, name.trim()) });
      refresh();
    } catch (e) {
      toast.error(`Create folder failed: ${e}`);
    }
  };

  const onDelete = async (entry) => {
    const ok = await confirm(
      `Delete ${entry.is_dir ? "folder" : "file"} "${entry.name}"? This cannot be undone.`,
      { title: "Delete?", confirmLabel: "delete", destructive: true }
    );
    if (!ok) return;
    try {
      await invoke("sftp_remove", { id: sessionId, path: entry.path, isDir: entry.is_dir });
      refresh();
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  };

  const onRename = async (entry) => {
    const next = window.prompt(`Rename "${entry.name}" to?`, entry.name);
    if (!next || !next.trim() || next.trim() === entry.name) return;
    try {
      await invoke("sftp_rename", { id: sessionId, from: entry.path, to: joinPath(cwd, next.trim()) });
      refresh();
    } catch (e) {
      toast.error(`Rename failed: ${e}`);
    }
  };

  return (
    <div
      className={docked ? "moba-dock-panel" : open ? "phn-snippets-drawer open" : "phn-snippets-drawer"}
      style={docked ? undefined : { width: 440 }}
      aria-hidden={!docked && !open}
    >
      <div className="phn-snippets-header">
        <span>📁 Remote files</span>
        {!docked && (
          <button className="phn-snippets-close" onClick={onClose} title="Close (Esc)">✕</button>
        )}
      </div>

      {/* Button toolbar (MobaXterm-style row above the path bar). */}
      <div className="moba-filebar">
        <button onClick={goHome} disabled={!sessionId} title="Home folder"><IconHome size={16} /></button>
        <button onClick={() => cwd && list(parentPath(cwd))} disabled={!cwd || cwd === "/"} title="Up one level"><IconUp size={16} /></button>
        <button onClick={refresh} disabled={!sessionId || !cwd} title="Refresh"><IconRefresh size={16} /></button>
        <span className="sep" />
        <button onClick={onUpload} disabled={!sessionId || !cwd} title="Upload a file into this folder"><IconUpload size={16} /></button>
        <button onClick={onMkdir} disabled={!sessionId || !cwd} title="New folder"><IconNewFolder size={16} /></button>
        <span className="grow" />
      </div>

      {sessionId && (
        <div className="phn-sftp-pathbar">
          <span className="path" title={cwd || ""}>{cwd || "…"}</span>
        </div>
      )}

      <div className="phn-snippets-list">
        {!sessionId && !connecting && !error ? (
          <div className="phn-snippets-empty">Open an SSH session, then choose <strong>Sftp</strong> to browse its files.</div>
        ) : connecting ? (
          <div className="phn-snippets-empty">Connecting…</div>
        ) : error ? (
          <div className="phn-snippets-empty" style={{ color: "#f87171" }}>{error}</div>
        ) : listError ? (
          <div className="phn-snippets-empty" style={{ color: "#f87171" }}>{listError}</div>
        ) : loading ? (
          <div className="phn-snippets-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="phn-snippets-empty">Empty directory.</div>
        ) : (
          entries.map((e) => (
            <div
              key={e.path}
              className="phn-sftp-row"
              onDoubleClick={() => (e.is_dir ? list(e.path) : setEditTarget(e))}
            >
              <span className="glyph">{fileGlyph(e)}</span>
              <span
                className={e.is_dir ? "name dir" : "name"}
                onClick={() => e.is_dir && list(e.path)}
                title={e.is_dir ? e.name : `${e.name} — double-click to edit`}
              >
                {e.name}
              </span>
              <span className="size">{e.is_dir ? "" : fmtSize(e.size)}</span>
              <span className="phn-sftp-actions">
                {!e.is_dir && (
                  <button onClick={(ev) => { ev.stopPropagation(); setEditTarget(e); }} title="Edit in app">✎</button>
                )}
                {!e.is_dir && (
                  <button onClick={(ev) => { ev.stopPropagation(); onDownload(e); }} title="Download">⬇</button>
                )}
                <button onClick={(ev) => { ev.stopPropagation(); onRename(e); }} title="Rename">↳</button>
                <button onClick={(ev) => { ev.stopPropagation(); onDelete(e); }} title="Delete">🗑</button>
              </span>
            </div>
          ))
        )}
      </div>

      <RemoteEditor
        open={!!editTarget}
        sessionId={sessionId}
        path={editTarget?.path}
        name={editTarget?.name}
        onClose={() => setEditTarget(null)}
      />
    </div>
  );
}
