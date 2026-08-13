// (C)
// Remote file browser (SFTP over the live ssh2 connection). Opened for the
// active SSH tab — the parent (TerminalsTab) calls sftp_connect and passes the
// session id. Navigate dirs, download/upload, mkdir, rename, delete. Transfers
// run entirely in Rust (rfd dialogs pick local paths); this UI only drives them.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@backend";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";
import { usePrompt } from "../../components/PromptModal.jsx";
import { FileIcon } from "./LocalFileBrowser.jsx";
import { IconHome, IconUp, IconRefresh, IconUpload, IconNewFolder } from "./icons.jsx";
import { SFolder, STrash } from "./toolbarIcons.jsx";
import RemoteEditor from "./RemoteEditor.jsx";

const LISTING_TTL_MS = 10_000;
const listingCache = new Map(); // `${sessionId}\0${path}` -> { entries, at }
const homeCache = new Map(); // sessionId -> home path

// Called by useSftpDock on sftp_disconnect: session ids are never reused, so
// without eviction every reconnect strands its entries in the module Maps.
export function evictSftpCaches(sessionId) {
  if (!sessionId) return;
  homeCache.delete(sessionId);
  const prefix = `${sessionId}\u0000`;
  for (const key of listingCache.keys()) {
    if (key.startsWith(prefix)) listingCache.delete(key);
  }
}

import "./terminals.css";

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtMtime(sec) {
  if (!sec) return "";
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}mo`;
  return `${Math.floor(d / 86400 / 365)}y`;
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
  const prompt = usePrompt();
  const [cwd, setCwd] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [editTarget, setEditTarget] = useState(null); // remote file open in the editor

  // Listing cache (P3-T5): keyed (sessionId, path) — path-only would serve
  // session A's listing to session B in the docked browser (audit M6). TTL
  // ~10s, render-immediately-then-revalidate: a cached entry paints with no
  // spinner while a background refetch replaces it. Mutations invalidate
  // their cwd BEFORE refresh() so a just-deleted row never repaints from
  // cache. Module-level so a dock collapse/reopen keeps warm listings.
  const list = useCallback(async (path) => {
    if (!sessionId) return;
    const key = `${sessionId}\u0000${path}`;
    const cached = listingCache.get(key);
    const fresh = cached && Date.now() - cached.at < LISTING_TTL_MS;
    if (cached) {
      // Paint immediately from cache (stale-while-revalidate).
      setEntries(cached.entries);
      setCwd(path);
      setListError(null);
      if (fresh) { setLoading(false); return; }
    } else {
      setLoading(true);
    }
    setListError(null);
    try {
      const items = await invoke("sftp_list", { id: sessionId, path });
      const entries = Array.isArray(items) ? items : [];
      listingCache.set(key, { entries, at: Date.now() });
      setEntries(entries);
      setCwd(path);
    } catch (e) {
      // A failed revalidate over a cached paint keeps the cached view.
      if (!cached) setListError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Drop the cached listing for a path (and optionally a removed dir's own
  // listing) before refetching — called by every mutation path.
  const invalidateListing = useCallback((path, alsoPath) => {
    if (path != null) listingCache.delete(`${sessionId}\u0000${path}`);
    if (alsoPath != null) listingCache.delete(`${sessionId}\u0000${alsoPath}`);
  }, [sessionId]);

  // When a session connects, resolve the home dir and list it.
  useEffect(() => {
    if ((!open && !docked) || !sessionId) return;
    let alive = true;
    (async () => {
      try {
        let home = homeCache.get(sessionId);
        if (!home) {
          home = await invoke("sftp_home", { id: sessionId });
          if (home) homeCache.set(sessionId, home);
        }
        if (alive) await list(home || "/");
      } catch (e) {
        if (alive) setListError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [open, docked, sessionId, list]);

  const refresh = useCallback(() => {
    if (!cwd) return;
    invalidateListing(cwd);
    list(cwd);
  }, [cwd, list, invalidateListing]);
  const goHome = useCallback(async () => {
    if (!sessionId) return;
    try {
      let home = homeCache.get(sessionId);
      if (!home) {
        home = await invoke("sftp_home", { id: sessionId });
        if (home) homeCache.set(sessionId, home);
      }
      await list(home || "/");
    } catch (e) { setListError(String(e)); }
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
    const name = await prompt("New folder name?", { title: "New folder", confirmLabel: "create", placeholder: "folder name" });
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
      // A deleted dir's OWN cached listing dies too (stream audit W5) —
      // refresh() only invalidates the cwd it lived in.
      if (entry.is_dir) invalidateListing(entry.path);
      refresh();
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  };

  const onRename = async (entry) => {
    const next = await prompt(`Rename "${entry.name}" to?`, { title: "Rename", confirmLabel: "rename", initialValue: entry.name });
    if (!next || !next.trim() || next.trim() === entry.name) return;
    try {
      await invoke("sftp_rename", { id: sessionId, from: entry.path, to: joinPath(cwd, next.trim()) });
      // The old path's own listing is stale after a dir rename (audit W5).
      if (entry.is_dir) invalidateListing(entry.path);
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SFolder size={13} /> Remote files</span>
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

      {sessionId && cwd && (
        <div className="phn-sftp-pathbar phn-sftp-crumb" title={cwd}>
          <span className="seg" onClick={() => list("/")}>/</span>
          {cwd.split("/").filter(Boolean).map((seg, i, arr) => {
            const path = "/" + arr.slice(0, i + 1).join("/");
            return (
              <span key={path} className="crumb-part">
                <span className="sl">›</span>
                <span className="seg" onClick={() => list(path)}>{seg}</span>
              </span>
            );
          })}
        </div>
      )}

      {sessionId && !connecting && !error && !listError && (
        <div className="phn-sftp-cols">
          <span className="name">Name</span>
          <span className="size">Size</span>
          <span className="mod">Mod</span>
        </div>
      )}

      <div className="phn-snippets-list">
        {!sessionId && !connecting && !error ? (
          <div className="phn-snippets-empty">Open an SSH session, then choose <strong>Sftp</strong> to browse its files.</div>
        ) : connecting ? (
          <div className="phn-snippets-empty">Connecting…</div>
        ) : error ? (
          <div className="phn-snippets-empty" style={{ color: "var(--phn-danger, #f87171)" }}>{error}</div>
        ) : listError ? (
          <div className="phn-snippets-empty" style={{ color: "var(--phn-danger, #f87171)" }}>{listError}</div>
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
              <span className="glyph"><FileIcon e={e} /></span>
              <span
                className={e.is_dir ? "name dir" : "name"}
                onClick={() => e.is_dir && list(e.path)}
                title={e.is_dir ? e.name : `${e.name} — double-click to edit`}
              >
                {e.name}
              </span>
              <span className="size">{e.is_dir ? "—" : fmtSize(e.size)}</span>
              <span className="mod">{fmtMtime(e.mtime)}</span>
              <span className="phn-sftp-actions">
                {!e.is_dir && (
                  <button onClick={(ev) => { ev.stopPropagation(); setEditTarget(e); }} title="Edit in app">✎</button>
                )}
                {!e.is_dir && (
                  <button onClick={(ev) => { ev.stopPropagation(); onDownload(e); }} title="Download">⬇</button>
                )}
                <button onClick={(ev) => { ev.stopPropagation(); onRename(e); }} title="Rename">↳</button>
                <button onClick={(ev) => { ev.stopPropagation(); onDelete(e); }} title="Delete"><STrash size={12} /></button>
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
