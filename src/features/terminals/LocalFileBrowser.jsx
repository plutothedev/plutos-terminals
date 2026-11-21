// (C)
// Local file-directory browser docked on the right — the workstation "SFTP"
// panel for the local filesystem (shown when the active tab isn't an SSH
// session). Breadcrumb + Name/Size/Mod columns + colored type icons, matching
// the remote SFTP dock. Double-click a folder to enter; "cd⇢" sends
// `cd <dir>` to the active terminal; clicking a file inserts its path.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import { IconHome, IconUp, IconRefresh, IconReveal, IconCd } from "./icons.jsx";
import { SFolder } from "./toolbarIcons.jsx";
import { IS_MAC } from "./keybindings.js";
import { humanizeError } from "./errorText.js";
import "./terminals.css";

// Platform-aware "reveal" tooltip (same detection pattern as keybindings'
// IS_MAC / formatCombo): Finder on macOS, File Explorer on Windows, generic
// elsewhere. IS_MAC is checked FIRST — /win/i alone would also match "darwin".
const IS_WIN = /win/i.test(
  (typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || ""
);
const REVEAL_TITLE = IS_MAC
  ? "Open this folder in Finder"
  : IS_WIN
    ? "Open this folder in File Explorer"
    : "Open this folder in your file manager";

// How many rows this dock will put in the DOM at once (audit PERF-1).
//
// Independent of the FETCH cap, which is a different number for a different
// reason: `list_directory` returns up to LIST_DIRECTORY_MAX entries
// (commands.rs), raised 5,000 -> 50,000 on 2026-08-16 so that System32-sized
// and node_modules-sized trees list at all. Nothing on this side changed to
// absorb that. Each row is ~8 elements including an inline <svg>, so an
// unwindowed render of a capped listing commits ~400,000 nodes in one
// synchronous pass, keeps them resident for the life of the dock, and
// reconciles all of them on every later render of the panel. The Files dock is
// the default right-dock content, so that is one double-click from a cold
// start.
//
// 500 is well past what fits on any screen; "Show more" below extends it in
// the same step, so nothing becomes unreachable: the listing is paged, not
// truncated.
export const DISPLAY_MAX = 500;

/**
 * The amber banner text above the list, or null when the listing is complete.
 *
 * Both truncations have to be legible at once, and the fetch cap is the
 * dangerous one: it breaks out of the backend read loop BEFORE the sort, so a
 * capped listing renders looking neatly alphabetical and complete while entries
 * are missing. `fetchTruncated` turns the total into a floor ("50,000+") rather
 * than letting it read as the real size of the folder.
 */
export function listingNotice({ shown, fetched, fetchTruncated }) {
  if (shown >= fetched && !fetchTruncated) return null;
  const total = `${fetched.toLocaleString()}${fetchTruncated ? "+" : ""}`;
  return `Showing ${shown.toLocaleString()} of ${total} entries.`;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Relative "modified" age for the Mod column (now / 2m / 1h / 3d / 5mo / 1y).
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

// Keyboard path for a click target that is not a native button: Enter or Space
// activates it, like the click does. Shared with the remote (SFTP) dock.
export function activateOnKey(fn) {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// Keyboard focus across a navigation. Enter on a folder (or on a crumb that the
// new listing drops) unmounts the element holding focus, which would leave the
// keyboard user on <body>. `byKey(fn)` wraps a keyboard action: once the next
// listing has settled (`settled` true, `version` changed), focus moves to the
// first focusable control in a row, else to the list itself (tabIndex -1).
// Mouse navigation is left alone, and so is a focus that survived (a crumb
// that is still on screen). Shared with the remote (SFTP) dock.
export function useRefocusAfterKeyNav(listRef, settled, version) {
  const pending = useRef(false);
  useEffect(() => {
    if (!settled || !pending.current) return;
    pending.current = false;
    const root = listRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    // First focusable inside a row (not the "Show more" notice above them).
    const first = root.querySelector('.phn-sftp-row [tabindex="0"], .phn-sftp-row button:not([disabled])');
    (first || root).focus();
  }, [settled, version, listRef]);
  return useCallback((fn) => () => { pending.current = true; fn(); }, []);
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
  // Starts true: the mount effect below fetches the home folder, so the first
  // paint is already the "Loading" state and the effect sets no state of its own.
  const [loading, setLoading] = useState(true);
  // The backend caps very large listings and reports it as a third tuple
  // element. Surfacing it matters: the cap breaks out of the read loop BEFORE
  // the sort, so a truncated listing renders looking neatly alphabetical and
  // complete while entries are missing. Left unread, that is a silent lie.
  const [truncated, setTruncated] = useState(false);
  // How many of `entries` are currently in the DOM (audit PERF-1). Grows by
  // DISPLAY_MAX per "Show more" click and resets on every navigation, so
  // walking into a huge directory never inherits a previous page's cap.
  const [limit, setLimit] = useState(DISPLAY_MAX);

  // The fetch itself. Sets state only after the await, so the mount effect can
  // call it without a synchronous setState in the effect body.
  const load = useCallback((path) => new Promise((resolve) => resolve(invoke("list_directory", { path: path ?? null })))
    .then(([resolved, items, wasTruncated]) => {
      setCwd(resolved);
      setEntries(Array.isArray(items) ? items : []);
      setTruncated(wasTruncated === true);
      setLimit(DISPLAY_MAX);
    })
    .catch((e) => {
      setError(humanizeError(e).message);
    })
    .finally(() => {
      setLoading(false);
    }), []);

  // Navigation entry point: flip to the loading state, then fetch.
  const list = useCallback((path) => {
    setLoading(true);
    setError(null);
    return load(path);
  }, [load]);

  useEffect(() => { load(null); }, [load]); // home dir on mount

  const listRef = useRef(null);
  const byKey = useRefocusAfterKeyNav(listRef, !loading, entries);

  // Breadcrumb, separator-agnostic. On Windows, list_directory returns
  // canonicalized paths (possibly a "\\?\" verbatim prefix + backslashes);
  // strip the prefix and split on either separator so the crumb works on both.
  const cleanCwd = (cwd || "").replace(/^\\\\\?\\/, "");
  const isWin = /\\/.test(cleanCwd) && !cleanCwd.startsWith("/");
  const segs = cleanCwd.split(/[/\\]+/).filter(Boolean);
  const crumbPath = (i) =>
    isWin ? segs.slice(0, i + 1).join("\\") : "/" + segs.slice(0, i + 1).join("/");

  const shown = limit >= entries.length ? entries : entries.slice(0, limit);
  const notice = listingNotice({
    shown: shown.length,
    fetched: entries.length,
    fetchTruncated: truncated,
  });
  const moreCount = Math.min(DISPLAY_MAX, entries.length - shown.length);

  return (
    <div className="moba-dock-panel">
      <div className="phn-snippets-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SFolder size={13} /> Files</span>
      </div>

      {/* Button toolbar (MobaXterm-style row above the breadcrumb). */}
      <div className="moba-filebar">
        <button title="Home folder" onClick={() => list(null)}><IconHome size={16} /></button>
        <button title="Up one level" onClick={() => cwd && list(parentPath(cwd))} disabled={!cwd || cwd === "/"}><IconUp size={16} /></button>
        <button title="Refresh" onClick={() => list(cwd)} disabled={!cwd}><IconRefresh size={16} /></button>
        <span className="sep" />
        <button title={REVEAL_TITLE} onClick={() => cwd && invoke("open_path", { path: cwd }).catch(() => {})} disabled={!cwd}><IconReveal size={16} /></button>
        {onSendToTerminal && (
          <button title="cd the active terminal into this folder" onClick={() => cwd && onSendToTerminal(`cd ${shQuote(cwd)}\r`)} disabled={!cwd}><IconCd size={16} /></button>
        )}
        <span className="grow" />
      </div>

      {cwd && (
        <div className="phn-sftp-pathbar phn-sftp-crumb" title={cwd}>
          {!isWin && <span className="seg" role="button" tabIndex={0} onClick={() => list("/")} onKeyDown={activateOnKey(byKey(() => list("/")))}>/</span>}
          {segs.map((seg, i) => {
            const path = crumbPath(i);
            return (
              <span key={path} className="crumb-part">
                <span className="sl">›</span>
                <span className="seg" role="button" tabIndex={0} onClick={() => list(path)} onKeyDown={activateOnKey(byKey(() => list(path)))}>{seg}</span>
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

      <div className="phn-snippets-list" ref={listRef} tabIndex={-1}>
        {!error && !loading && notice && (
          <div className="phn-snippets-empty" style={{ color: "#FBBF24" }}>
            {notice}
            {moreCount > 0 && (
              <button
                type="button"
                onClick={() => setLimit((n) => n + DISPLAY_MAX)}
                title="Add another page of entries to the list"
                style={{
                  marginLeft: 6,
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                  textDecoration: "underline",
                  cursor: "pointer",
                }}
              >
                Show {moreCount.toLocaleString()} more
              </button>
            )}
          </div>
        )}
        {error ? (
          <div className="phn-snippets-empty" style={{ color: "#f87171" }}>{error}</div>
        ) : loading ? (
          <div className="phn-snippets-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="phn-snippets-empty">Empty folder.</div>
        ) : (
          shown.map((e) => (
            <div
              key={e.path}
              className="phn-sftp-row"
              onDoubleClick={() => e.is_dir && list(e.path)}
            >
              <span className="glyph"><FileIcon e={e} /></span>
              <span
                className={e.is_dir ? "name dir" : "name"}
                role="button"
                tabIndex={0}
                onClick={() => (e.is_dir ? list(e.path) : onSendToTerminal?.(`${shQuote(e.path)} `))}
                onKeyDown={activateOnKey(e.is_dir ? byKey(() => list(e.path)) : () => onSendToTerminal?.(`${shQuote(e.path)} `))}
                title={e.is_dir ? e.name : `${e.name}: click to insert path`}
              >
                {e.name}
              </span>
              <span className="size">{e.is_dir ? "-" : fmtSize(e.size)}</span>
              <span className="mod">{fmtMtime(e.mtime)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
