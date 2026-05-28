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

// MobaXterm-style file iconography: yellow folders + type-specific file glyphs.
export function fileGlyph(e) {
  if (e.is_dir) return "📁";
  const ext = (e.name.split(".").pop() || "").toLowerCase();
  if (/^(png|jpe?g|gif|svg|webp|bmp|ico|tiff?)$/.test(ext)) return "🖼";
  if (/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(ext)) return "🗜";
  if (/^(js|ts|jsx|tsx|mjs|cjs)$/.test(ext)) return "📜";
  if (/^(json|ya?ml|toml|ini|conf|cfg|env)$/.test(ext)) return "⚙️";
  if (/^(md|markdown|txt|rst|log)$/.test(ext)) return "📝";
  if (/^py$/.test(ext)) return "🐍";
  if (/^rs$/.test(ext)) return "🦀";
  if (/^(sh|bash|zsh|fish)$/.test(ext)) return "⌨️";
  if (/^pdf$/.test(ext)) return "📕";
  if (/^(mp3|wav|flac|ogg|m4a)$/.test(ext)) return "🎵";
  if (/^(mp4|mov|mkv|avi|webm)$/.test(ext)) return "🎬";
  return "📄";
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
      </div>

      {/* Button toolbar (MobaXterm-style row above the path bar). */}
      <div className="moba-filebar">
        <button title="Home folder" onClick={() => list(null)}>⌂</button>
        <button title="Up one level" onClick={() => cwd && list(parentPath(cwd))} disabled={!cwd || cwd === "/"}>↑</button>
        <button title="Refresh" onClick={() => list(cwd)} disabled={!cwd}>⟳</button>
        <span className="sep" />
        <button title="Open this folder in Finder" onClick={() => cwd && invoke("open_path", { path: cwd }).catch(() => {})} disabled={!cwd}>⧉</button>
        {onSendToTerminal && (
          <button title="cd the active terminal into this folder" onClick={() => cwd && onSendToTerminal(`cd ${shQuote(cwd)}\r`)} disabled={!cwd}>⇢</button>
        )}
        <span className="grow" />
      </div>

      <div className="phn-sftp-pathbar">
        <span className="path" title={cwd || ""}>{cwd || "…"}</span>
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
              <span className="glyph">{fileGlyph(e)}</span>
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
