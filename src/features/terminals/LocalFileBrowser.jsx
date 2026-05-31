// (C)
// Local file-directory browser docked on the right — the workstation "SFTP"
// panel for the local filesystem (shown when the active tab isn't an SSH
// session). Breadcrumb + Name/Size/Mod columns + colored type icons, matching
// the remote SFTP dock. Double-click a folder to enter; "cd⇢" sends
// `cd <dir>` to the active terminal; clicking a file inserts its path.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@backend";
import { IconHome, IconUp, IconRefresh, IconReveal, IconCd } from "./icons.jsx";
import "./terminals.css";

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Relative "modified" age for the Mod column (now / 2m / 1h / 3d / 5mo / 1y).
export function fmtMtime(sec) {
  if (!sec) return "";
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}mo`;
  return `${Math.floor(d / 86400 / 365)}y`;
}

// Parent dir, separator-agnostic (Windows paths use "\", POSIX use "/").
function parentPath(p) {
  const t = p.replace(/[/\\]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i <= 0 ? "/" : t.slice(0, i);
}

// Single-quote a path for the shell, escaping embedded quotes.
function shQuote(p) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

// File color by type (mockup palette): yellow folders, orange code, green
// config/manifests, blue docs, magenta media, gray dotfiles.
function fileColor(e) {
  if (e.is_dir) return "#E0C04F";
  const name = (e.name || "").toLowerCase();
  if (name.startsWith(".")) return "#878D95";
  const ext = name.split(".").pop() || "";
  if (/^(rs|js|ts|jsx|tsx|mjs|cjs|py|go|c|cc|cpp|h|hpp|java|rb|php|swift|kt|scala|sh|bash|zsh|fish)$/.test(ext)) return "#E0863C";
  if (/^(json|ya?ml|toml|ini|conf|cfg|lock|env|xml|gradle|properties)$/.test(ext)) return "#6FB85C";
  if (/^(md|markdown|txt|rst|log|pdf|doc|docx)$/.test(ext)) return "#5B9BE0";
  if (/^(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|mp4|mov|mkv|avi|webm|mp3|wav|flac|ogg|m4a)$/.test(ext)) return "#D982D9";
  if (/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(ext)) return "#C9A24B";
  return "#9AA0A8";
}

const FOLDER_PATH = <path d="M2 4.5a1 1 0 0 1 1-1h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />;
const FILE_PATH = <><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></>;

// Crisp colored stroke icon for a file/dir entry — shared by the local and
// remote (SFTP) docks so both read like the mockup's colorful file list.
export function FileIcon({ e, size = 13 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={fileColor(e)}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden="true"
    >
      {e.is_dir ? FOLDER_PATH : FILE_PATH}
    </svg>
  );
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

  // Breadcrumb, separator-agnostic. On Windows, list_directory returns
  // canonicalized paths (possibly a "\\?\" verbatim prefix + backslashes);
  // strip the prefix and split on either separator so the crumb works on both.
  const cleanCwd = (cwd || "").replace(/^\\\\\?\\/, "");
  const isWin = /\\/.test(cleanCwd) && !cleanCwd.startsWith("/");
  const segs = cleanCwd.split(/[/\\]+/).filter(Boolean);
  const crumbPath = (i) =>
    isWin ? segs.slice(0, i + 1).join("\\") : "/" + segs.slice(0, i + 1).join("/");

  return (
    <div className="moba-dock-panel">
      <div className="phn-snippets-header">
        <span>📁 Files</span>
      </div>

      {/* Button toolbar (MobaXterm-style row above the breadcrumb). */}
      <div className="moba-filebar">
        <button title="Home folder" onClick={() => list(null)}><IconHome size={16} /></button>
        <button title="Up one level" onClick={() => cwd && list(parentPath(cwd))} disabled={!cwd || cwd === "/"}><IconUp size={16} /></button>
        <button title="Refresh" onClick={() => list(cwd)} disabled={!cwd}><IconRefresh size={16} /></button>
        <span className="sep" />
        <button title="Open this folder in Finder" onClick={() => cwd && invoke("open_path", { path: cwd }).catch(() => {})} disabled={!cwd}><IconReveal size={16} /></button>
        {onSendToTerminal && (
          <button title="cd the active terminal into this folder" onClick={() => cwd && onSendToTerminal(`cd ${shQuote(cwd)}\r`)} disabled={!cwd}><IconCd size={16} /></button>
        )}
        <span className="grow" />
      </div>

      {cwd && (
        <div className="phn-sftp-pathbar phn-sftp-crumb" title={cwd}>
          {!isWin && <span className="seg" onClick={() => list("/")}>/</span>}
          {segs.map((seg, i) => {
            const path = crumbPath(i);
            return (
              <span key={path} className="crumb-part">
                <span className="sl">›</span>
                <span className="seg" onClick={() => list(path)}>{seg}</span>
              </span>
            );
          })}
        </div>
      )}

      {!error && (
        <div className="phn-sftp-cols">
          <span className="name">Name</span>
          <span className="size">Size</span>
          <span className="mod">Mod</span>
        </div>
      )}

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
              <span className="glyph"><FileIcon e={e} /></span>
              <span
                className={e.is_dir ? "name dir" : "name"}
                onClick={() => (e.is_dir ? list(e.path) : onSendToTerminal?.(`${shQuote(e.path)} `))}
                title={e.is_dir ? e.name : `${e.name} — click to insert path`}
              >
                {e.name}
              </span>
              <span className="size">{e.is_dir ? "—" : fmtSize(e.size)}</span>
              <span className="mod">{fmtMtime(e.mtime)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
