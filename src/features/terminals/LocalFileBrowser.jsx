// (C)
// Local file-directory browser docked on the left — the MobaXterm "Sftp" panel
// for the local filesystem (shown when the active tab isn't an SSH session).
// Path bar + up/home/refresh, folder/file tree. Double-click a folder to enter;
// "cd⇢" sends `cd <dir>` to the active terminal; clicking a file inserts its
// path into the active terminal.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./terminals.css";

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function parentPath(p) {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

// Single-quote a path for the shell, escaping embedded quotes.
function shQuote(p) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export default function LocalFileBrowser({ onSendToTerminal }) {
  const [cwd, setCwd] = useState(null);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const list = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const [resolved, items] = await invoke("list_directory", { path: path ?? null });
      setCwd(resolved);
      setEntries(Array.isArray(items) ? items : []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { list(null); }, [list]); // home dir on mount

  return (
    <div className="moba-dock-panel">
      <div className="phn-snippets-header">
        <span>📁 Files</span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button className="phn-snippets-close" title="Home" onClick={() => list(null)}>⌂</button>
          <button className="phn-snippets-close" title="Refresh" onClick={() => list(cwd)} disabled={!cwd}>⟳</button>
        </div>
      </div>

      <div className="phn-sftp-pathbar">
        <button className="phn-sftp-up" onClick={() => cwd && list(parentPath(cwd))} disabled={!cwd || cwd === "/"} title="Up one level">↑</button>
        <span className="path" title={cwd || ""}>{cwd || "…"}</span>
        {onSendToTerminal && cwd && (
          <button className="phn-sftp-up" title="cd the active terminal into this folder" onClick={() => onSendToTerminal(`cd ${shQuote(cwd)}\r`)}>cd⇢</button>
        )}
      </div>

      <div className="phn-snippets-list">
        {error ? (
          <div className="phn-snippets-empty" style={{ color: "#f87171" }}>{error}</div>
        ) : loading ? (
          <div className="phn-snippets-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="phn-snippets-empty">Empty folder.</div>
        ) : (
          entries.map((e) => (
            <div
              key={e.path}
              className="phn-sftp-row"
              onDoubleClick={() => e.is_dir && list(e.path)}
            >
              <span style={{ flexShrink: 0 }}>{e.is_dir ? "📁" : "📄"}</span>
              <span
                className={e.is_dir ? "name dir" : "name"}
                onClick={() => (e.is_dir ? list(e.path) : onSendToTerminal?.(`${shQuote(e.path)} `))}
                title={e.is_dir ? e.name : `${e.name} — click to insert path`}
              >
                {e.name}
              </span>
              <span className="size">{e.is_dir ? "" : fmtSize(e.size)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
