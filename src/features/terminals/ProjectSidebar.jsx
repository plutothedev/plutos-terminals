// (C)
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@backend";
import "./terminals.css";
import { SLocal, SSsh, SWindows, SServer, SBox, SBot, SModels, SFolder, SAgents } from "./toolbarIcons.jsx";
import { useProjectRollups } from "./activityStore.js";

const SIDEBAR_BG = "var(--phn-surface-alt-bg, #0d0d0d)";
const HEADER_BG = "var(--phn-surface-bg, #181818)";
const FG = "var(--phn-text-fg, #CCCCCC)";
const FG_DIM = "var(--phn-text-dim, #9D9D9D)";
const FG_FAINT = "var(--phn-text-dim, #555555)";
const ACCENT = "var(--phn-link, #7c9cf5)";
const BORDER = "var(--phn-surface-border, #2B2B2B)";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

const COLOR_PALETTE = [
  { id: "red",    hex: "#F87171" },
  { id: "amber",  hex: "#FBBF24" },
  { id: "green",  hex: "#34D399" },
  { id: "blue",   hex: "#60A5FA" },
  { id: "purple", hex: "#A78BFA" },
  { id: "pink",   hex: "#F472B6" },
  { id: "teal",   hex: "#2DD4BF" },
  { id: "gray",   hex: "#9CA3AF" },
];

const colorHex = (id) => COLOR_PALETTE.find(c => c.id === id)?.hex || FG_FAINT;

// SSH sessions carry a `connection`; older/local records have a `path`.
const isSsh = (p) => p?.type === "ssh" || (!!p?.connection && !p?.path);

// MobaXterm-style platform icons: infer the OS/platform from the session name,
// folder, host, or path so the tree reads like MobaXterm's categorised list.
// Monochrome stroke glyphs (reskin) — falls back to a generic host/computer icon.
function platformGlyph(p) {
  const hay = `${p?.name || ""} ${p?.folder || ""} ${p?.connection?.host || ""} ${p?.path || ""}`.toLowerCase();
  if (/(ubuntu|debian|linux|fedora|centos|arch|alpine|redhat|rhel|kali|suse)/.test(hay)) return <SServer size={13} />;
  if (/(windows|win10|win11|wsl|\bwin\b)/.test(hay)) return <SWindows size={13} />;
  if (/(macos|macbook|apple|osx|darwin|\bmac\b)/.test(hay)) return <SLocal size={13} />;
  if (/(android)/.test(hay)) return <SBot size={13} />;
  if (/(raspberry|\brpi\b)/.test(hay)) return <SModels size={13} />;
  if (/(aix|solaris|\bunix\b|\bbsd\b)/.test(hay)) return <SServer size={13} />;
  if (/(docker|container|k8s|kube)/.test(hay)) return <SBox size={13} />;
  return isSsh(p) ? <SSsh size={13} /> : <SLocal size={13} />;
}
const typeGlyph = (p) => platformGlyph(p);

// Colored stroke OS-type icons, ported 1:1 from the mockup (#i-tux / #i-win /
// #i-branch / #i-mon). All stroke (fill:none) for the crisp line-art look; the
// color encodes platform: orange Linux, blue Windows/RDP, green agent worktree,
// blue local monitor.
const OS_PATHS = {
  tux: <path d="M8 2.5c-1.7 0-2.6 1.5-2.6 3.2 0 1-.5 1.6-1.2 2.6C3.2 9.7 3 11 4 12c.7.7 1.6.4 2 1 .5.7 3 .7 3.4 0 .4-.6 1.3-.3 2-1 1-1 .8-2.3-.2-3.7-.7-1-1.2-1.6-1.2-2.6C9.8 4 8.9 2.5 8 2.5z" />,
  win: <path d="M2.5 4.2 7.3 3.5v4.2H2.5zM8.3 3.4 14 2.5v5.2H8.3zM2.5 8.7h4.8v3.8L2.5 11.8zM8.3 8.7H14v5.2l-5.7-.9z" />,
  branch: <><circle cx="4.5" cy="3.5" r="1.7" /><circle cx="4.5" cy="12.5" r="1.7" /><circle cx="11.5" cy="3.5" r="1.7" /><path d="M4.5 5.2v5.6M4.5 8.5h3a4 4 0 0 0 4-4V5.2" /></>,
  mon: <><rect x="2" y="2.5" width="12" height="8.5" rx="1" /><path d="M6 14h4M8 11v3" /></>,
};
function osIconFor(p) {
  const hay = `${p?.name || ""} ${p?.folder || ""} ${p?.connection?.host || ""} ${p?.path || ""}`.toLowerCase();
  if (p?.worktree || /agent/.test((p?.folder || "").toLowerCase())) return { id: "branch", color: "#6FB85C" };
  if (p?.rdp || p?.vnc || /(windows|win10|win11|wsl|\bwin\b|rdp)/.test(hay)) return { id: "win", color: "#5B9BE0" };
  if (isSsh(p)) return { id: "tux", color: "#E0863C" };
  return { id: "mon", color: "#5B9BE0" };
}
function OsIcon({ p, info, size = 13 }) {
  const { id, color } = info || osIconFor(p);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color}
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }} aria-hidden="true">
      {OS_PATHS[id]}
    </svg>
  );
}

// Folder icon by name keyword (mirrors MobaXterm's per-category folder icons).
// Monochrome stroke glyphs (reskin).
function folderGlyph(name) {
  const n = (name || "").toLowerCase();
  if (/(ubuntu|debian|linux|fedora|centos|arch|alpine|redhat|rhel|kali|suse)/.test(n)) return <SServer size={12} />;
  if (/(windows|win10|win11|wsl|\bwin\b)/.test(n)) return <SWindows size={12} />;
  if (/(macos|macbook|apple|osx|darwin|\bmac\b)/.test(n)) return <SLocal size={12} />;
  if (/(prod|production|server)/.test(n)) return <SServer size={12} />;
  if (/(docker|container|k8s|kube)/.test(n)) return <SBox size={12} />;
  if (/(local|dev|project)/.test(n)) return <SLocal size={12} />;
  return <SFolder size={12} />;
}

// Spawn a floating drag preview that follows the cursor.
function makeGhost(label, color) {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "top:0","left:0",
    "pointer-events:none",
    "z-index:99999",
    `background:${color || ACCENT}`,
    "color:#001",
    "padding:3px 9px",
    "border-radius:3px",
    `font:11px/1 ${M}`,
    "font-weight:600",
    "box-shadow:0 4px 12px rgba(0,0,0,0.5)",
    "white-space:nowrap",
    "transform:translate(-9999px,-9999px)",
  ].join(";");
  el.textContent = label;
  document.body.appendChild(el);
  return el;
}

function clearAllDropHighlights() {
  document.querySelectorAll("[data-panel-id][data-drop='1']").forEach(el => {
    el.removeAttribute("data-drop");
    el.style.outline = "";
    el.style.outlineOffset = "";
  });
}

function highlightPanel(el) {
  if (!el || el.getAttribute("data-drop") === "1") return;
  el.setAttribute("data-drop", "1");
  el.style.outline = `2px solid ${ACCENT}`;
  el.style.outlineOffset = "-2px";
}

// Activity tints for project rows (mirror tab dot colors).
const ACTIVE_FG = "rgba(250,204,21,0.85)";
const DONE_FG = "#34D399";
// Blocked-on-you amber, matching the Monitor's waiting dot. Deliberately
// warmer/more saturated than ACTIVE_FG so "needs you" and "running" stay
// distinguishable at a glance in a row of projects.
const WAITING_FG = "#E0A93C";

function ProjectSidebar({
  projects,
  collapsed = false,
  onToggleCollapse,
  onCollapse,
  docked = false,
  onClickProject,
  onAddProject,
  onRemoveProject,
  onEditProject,
  onColorProject,
  onRenameProject,
  onDropProject,
  onRunScript,
  onForgetPassword,
  onSetFolder,
  onNewWorktreeAgent,
}) {
  const [hoverId, setHoverId] = useState(null);
  const [query, setQuery] = useState(""); // project name filter
  const [latency, setLatency] = useState({}); // projectId -> ms | null (SSH hosts)
  // Collapsed folders in the Sessions tree (transient — names, not ids).
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());

  // Per-SSH-host latency (TCP connect to the SSH port), shown next to the
  // host in the tree. P2-T4: ONE batched invoke + ONE setState per 30s cycle
  // (the old loop was N sequential invokes + N sidebar re-renders, running
  // even while the window was hidden to the tray). The hidden check lives
  // INSIDE the tick — never tear the interval down on visibility, or a missed
  // "visible" event would strand polling off — and a visible-flip refreshes
  // immediately. Single-flight guards a slow batch overlapping the next tick.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const ssh = (projects || []).filter((p) => isSsh(p) && p.connection?.host);
    if (ssh.length === 0) return undefined;
    const probe = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const hosts = ssh.map((p) => [p.connection.host, p.connection.port || 22]);
        const byKey = await invoke("net_latency_many", { hosts });
        if (!cancelled && byKey) {
          setLatency((m) => {
            const next = { ...m };
            // host:port keys (T4 review W1): host-only lookup collapsed two
            // projects on one box with different sshd ports.
            for (const p of ssh) {
              next[p.id] = byKey[`${p.connection.host}:${p.connection.port || 22}`] ?? null;
            }
            return next;
          });
        }
      } catch { /* ignore */ } finally { inFlight = false; }
    };
    probe();
    const t = setInterval(probe, 30000);
    const onVis = () => { if (!document.hidden) probe(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [projects]);
  const toggleFolder = (name) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const [ctxMenu, setCtxMenu] = useState(null); // {x, y, projectId}
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);

  // Git branch + dirty state per project, refreshed every 30s while the
  // sidebar is open. P2-T4: ONE batched invoke (chunked scoped threads on the
  // Rust side — the old N concurrent invokes each pinned a tokio worker on a
  // blocking git subprocess, queueing keystroke dispatch behind the fan-out)
  // + ONE setState; hidden-gated per tick with a visible-flip refresh;
  // single-flight for cold/network repos.
  const [gitStatus, setGitStatus] = useState({}); // {projectId: {branch, dirty} | null}
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const withPath = projects.filter((p) => p.path);
    if (withPath.length === 0) return undefined;
    const refresh = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const byCwd = await invoke("git_branch_status_many", {
          cwds: withPath.map((p) => p.path),
        });
        if (!cancelled && byCwd) {
          setGitStatus((prev) => {
            const next = { ...prev };
            for (const p of withPath) next[p.id] = byCwd[p.path] || null;
            return next;
          });
        }
      } catch { /* ignore */ } finally { inFlight = false; }
    };
    refresh();
    const t = setInterval(refresh, 30000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [projects]);

  // npm scripts per project. Lazily fetched when the right-click menu opens.
  const [npmScripts, setNpmScripts] = useState({}); // {projectId: string[]}

  // Recent files per project. Fetched on first expand; cached for the session.
  const [recentFiles, setRecentFiles] = useState({}); // {projectId: string[]}
  const [expandedId, setExpandedId] = useState(null); // only one project expanded at a time

  // Per-project activity rollups from the store (P2-T1): cached-object
  // subscription — an agent flip re-renders the sidebar (rows + shake below),
  // but no longer the whole app on the way here.
  const projectActivities = useProjectRollups();

  // Shake projects whose tied tab just transitioned active→done. Tracks
  // previous per-project activity in a ref; a 400ms class flicker drives
  // the CSS animation defined in terminals.css.
  const prevActivityRef = useRef({});
  const [shakingIds, setShakingIds] = useState(new Set());
  useEffect(() => {
    const newlyDone = [];
    for (const [id, state] of Object.entries(projectActivities || {})) {
      if (state === "done" && prevActivityRef.current[id] === "active") {
        newlyDone.push(id);
      }
    }
    prevActivityRef.current = projectActivities || {};
    if (newlyDone.length === 0) return;
    setShakingIds(prev => {
      const next = new Set(prev);
      newlyDone.forEach(id => next.add(id));
      return next;
    });
    const t = setTimeout(() => {
      setShakingIds(prev => {
        const next = new Set(prev);
        newlyDone.forEach(id => next.delete(id));
        return next;
      });
    }, 420);
    return () => clearTimeout(t);
  }, [projectActivities]);

  const closeCtx = () => setCtxMenu(null);

  const toggleExpand = (project) => {
    if (expandedId === project.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(project.id);
    if (!recentFiles[project.id] && project.path) {
      invoke("recent_files", { cwd: project.path })
        .then(files => {
          setRecentFiles(prev => ({ ...prev, [project.id]: Array.isArray(files) ? files : [] }));
        })
        .catch(() => {
          setRecentFiles(prev => ({ ...prev, [project.id]: [] }));
        });
    }
  };

  const startRename = (project) => {
    setRenamingId(project.id);
    setRenameValue(project.name || "");
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };
  const commitRename = () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) onRenameProject?.(renamingId, trimmed);
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);

  // Mousedown on a project row: handles both click (no movement) and drag (moved >4px).
  const handleRowMouseDown = (project, e) => {
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let ghost = null;
    let lastTargetEl = null;

    const onMove = (ev) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (!dragging && (dx > 4 || dy > 4)) {
        dragging = true;
        ghost = makeGhost(project.name, colorHex(project.color));
      }
      if (dragging && ghost) {
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const panel = el?.closest("[data-panel-id]");
        if (panel !== lastTargetEl) {
          clearAllDropHighlights();
          if (panel) highlightPanel(panel);
          lastTargetEl = panel || null;
        }
      }
    };

    const onUp = (ev) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (ghost) ghost.remove();
      const finalTarget = lastTargetEl;
      clearAllDropHighlights();
      if (dragging) {
        const panelId = finalTarget?.getAttribute("data-panel-id");
        if (panelId) onDropProject(project.id, panelId);
      } else {
        onClickProject(project.id);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  };

  const handleRowContextMenu = (project, e) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, projectId: project.id });
    // Fetch npm scripts in the background; menu re-renders when state lands.
    if (project.path) {
      invoke("read_npm_scripts", { cwd: project.path })
        .then(scripts => {
          setNpmScripts(prev => ({ ...prev, [project.id]: Array.isArray(scripts) ? scripts : [] }));
        })
        .catch(() => {});
    }
  };

  // Search matches name, folder, host, path, and tags. A leading "#" filters by
  // tag specifically (e.g. "#prod"); otherwise it's a substring match over the
  // whole haystack. P2-T4: haystacks + lowered tags precompute ONCE per
  // projects change instead of per row per keystroke (the old inline build
  // ran string concat + toLowerCase for all N rows on every input event).
  const searchIndex = useMemo(() => {
    const idx = new Map();
    for (const p of projects) {
      const tags = Array.isArray(p.tags) ? p.tags : [];
      idx.set(p.id, {
        hay: `${p.name || ""} ${p.folder || ""} ${p.connection?.host || ""} ${p.rdp?.host || ""} ${p.vnc?.host || ""} ${p.path || ""} ${tags.join(" ")}`.toLowerCase(),
        tags: tags.map((t) => String(t).toLowerCase()),
        // Icon classification runs 4 regexes over a concat — once per
        // projects change here, not per row per render.
        iconInfo: osIconFor(p),
      });
    }
    return idx;
  }, [projects]);
  const q = query.trim().toLowerCase();
  const matchesQuery = (p) => {
    if (!q) return true;
    const entry = searchIndex.get(p.id);
    if (!entry) return true;
    if (q.startsWith("#")) {
      const t = q.slice(1);
      return entry.tags.some((tag) => tag.includes(t));
    }
    return entry.hay.includes(q);
  };
  const visibleProjects = q ? projects.filter(matchesQuery) : projects;

  return (
    <div
      className={collapsed && !docked ? "phn-sidebar phn-sidebar-collapsed" : "phn-sidebar"}
      style={{
        width: docked ? "100%" : collapsed ? 48 : 200,
        minWidth: docked ? 0 : collapsed ? 48 : 200,
        flexShrink: docked ? 1 : 0,
        display: "flex",
        flexDirection: "column",
        fontSize: 12,
        overflow: "hidden",
        transition: "width 0.18s ease, min-width 0.18s ease",
      }}
    >
      <div
        className="phn-sidebar-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: collapsed ? "6px 0" : "6px 8px 6px 10px",
          justifyContent: collapsed ? "center" : "flex-start",
          minHeight: 32,
          boxSizing: "border-box",
        }}
      >
        {!collapsed && (
          <span className="phn-sidebar-rowtext" style={{ flex: 1, color: FG_DIM, letterSpacing: 0.5, fontSize: 10 }}>SESSIONS</span>
        )}
        {!collapsed && (
          <button
            onClick={onAddProject}
            title="Add session (local shell or SSH host)"
            style={{
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: ACCENT,
              cursor: "pointer",
              padding: "0 8px",
              height: 20,
              borderRadius: 3,
              fontFamily: M,
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            +
          </button>
        )}
        {!docked && (
          <button
            className="phn-sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "»" : "«"}
          </button>
        )}
        {docked && onCollapse && (
          <button className="moba-tree-collapse" onClick={onCollapse} title="Collapse sessions panel">‹</button>
        )}
      </div>

      {!collapsed && projects.length > 0 && (
        <div className="phn-sidebar-search-wrap">
          <input
            className="phn-sidebar-search"
            type="text"
            placeholder="Search name, host, folder, #tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setQuery(""); } }}
            spellCheck={false}
          />
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {projects.length === 0 ? (
          collapsed ? null : (
          <div style={{ padding: "28px 16px", color: FG_FAINT, textAlign: "center", fontSize: 11, lineHeight: 1.5 }}>
            <div style={{ marginBottom: 12, opacity: 0.6, display: "flex", justifyContent: "center" }}><SFolder size={24} /></div>
            <div style={{ marginBottom: 14, color: FG_DIM }}>
              No sessions yet.<br />Add a local folder or an SSH host.
            </div>
            <button
              onClick={onAddProject}
              style={{
                background: "transparent",
                border: `1px solid ${ACCENT}`,
                color: ACCENT,
                padding: "5px 12px",
                borderRadius: 3,
                fontFamily: M,
                fontSize: 11,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(124,156,245,0.1)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              + Add session
            </button>
          </div>
          )
        ) : visibleProjects.length === 0 ? (
          <div className="phn-snippets-empty">No sessions match "{query}".</div>
        ) : (() => {
          const renderRow = (p) => {
            const isHover = hoverId === p.id;
            const isRenamingThis = renamingId === p.id;
            const isExpanded = expandedId === p.id;
            const activity = projectActivities?.[p.id];
            // "waiting" (an agent blocked on your approval) gets its own amber,
            // distinct from the running yellow and the finished green — it is
            // the state you should act on, so it must not read as either.
            const activityFg =
              activity === "waiting" ? WAITING_FG
                : activity === "active" ? ACTIVE_FG
                : activity === "done" ? DONE_FG
                : null;
            const nameColor = activityFg || FG;
            const dotShadow = activityFg ? `0 0 6px ${activityFg}` : "none";
            return (
              <div key={p.id}>
              <div
                className={shakingIds.has(p.id) ? "tg-shake" : undefined}
                onMouseDown={(e) => { if (!isRenamingThis) handleRowMouseDown(p, e); }}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(p); }}
                onContextMenu={(e) => handleRowContextMenu(p, e)}
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId(null)}
                title={collapsed ? p.name : (isRenamingThis ? "Editing — press Enter to save, Esc to cancel" : (isSsh(p) ? `${p.connection?.user || ""}@${p.connection?.host || ""}:${p.connection?.port || 22} (double-click to rename)` : `${p.path} (double-click to rename)`))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: collapsed ? "6px 0" : "3px 10px",
                  minHeight: collapsed ? undefined : 23,
                  justifyContent: collapsed ? "center" : "flex-start",
                  cursor: isRenamingThis ? "text" : "pointer",
                  background: isHover ? "rgba(255,255,255,0.04)" : "transparent",
                  userSelect: "none",
                  fontSize: 12.5,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: colorHex(p.color),
                    flexShrink: 0,
                    boxShadow: dotShadow,
                    transition: "box-shadow 0.2s",
                  }}
                />
                {!collapsed && (
                <>
                {isRenamingThis ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                    }}
                    spellCheck={false}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: "rgba(255,255,255,0.06)",
                      border: `1px solid ${ACCENT}`,
                      color: "#fff",
                      fontFamily: M,
                      fontSize: 11,
                      padding: "0 4px",
                      outline: "none",
                      borderRadius: 2,
                    }}
                  />
                ) : (
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 5 }}>
                    <span
                      style={{ flexShrink: 0, display: "flex", alignItems: "center", alignSelf: "center" }}
                      title={isSsh(p) ? "SSH session" : "Local shell"}
                    >
                      <OsIcon p={p} info={searchIndex.get(p.id)?.iconInfo} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: nameColor,
                        transition: "color 0.2s",
                      }}
                    >
                      {p.name}
                    </span>
                    {Array.isArray(p.tags) && p.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setQuery(`#${tag}`); }}
                        title={`Filter by #${tag}`}
                        style={{
                          flexShrink: 0, fontSize: 8.5, lineHeight: 1.4, padding: "0 4px",
                          borderRadius: 6, background: "rgba(120,120,160,0.18)",
                          color: FG_DIM, cursor: "pointer", whiteSpace: "nowrap",
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                    {isSsh(p) && p.id in latency && !collapsed && (
                      <span
                        style={{
                          flexShrink: 0,
                          marginLeft: "auto",
                          fontSize: 9.5,
                          letterSpacing: 0.2,
                          color: latency[p.id] == null ? FG_FAINT : latency[p.id] < 80 ? "var(--phn-success, #5FB87A)" : "var(--phn-warning, #E0A93C)",
                          fontFamily: M,
                        }}
                        title={latency[p.id] == null ? "Unreachable on SSH port" : `SSH connect latency: ${latency[p.id]}ms`}
                      >
                        {latency[p.id] == null ? "—" : `${latency[p.id]}ms`}
                      </span>
                    )}
                    {!isSsh(p) ? (
                      gitStatus[p.id] && (
                        <span
                          style={{
                            flexShrink: 0,
                            marginLeft: "auto",
                            color: FG_FAINT,
                            fontSize: 9.5,
                            letterSpacing: 0.3,
                            maxWidth: 90,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={`Branch: ${gitStatus[p.id].branch}${gitStatus[p.id].dirty ? " (dirty)" : ""}`}
                        >
                          {gitStatus[p.id].branch}
                          {gitStatus[p.id].dirty && (
                            <span style={{ color: "#FBBF24", marginLeft: 1 }}>*</span>
                          )}
                        </span>
                      )
                    ) : null}
                  </div>
                )}
                {!isRenamingThis && !isSsh(p) && (
                  <span
                    onMouseDown={(e) => { e.stopPropagation(); }}
                    onClick={(e) => { e.stopPropagation(); toggleExpand(p); }}
                    title={expandedId === p.id ? "Hide recent files" : "Show recent files"}
                    style={{
                      color: expandedId === p.id ? ACCENT : (isHover ? FG_DIM : FG_FAINT),
                      cursor: "pointer",
                      fontSize: 9,
                      padding: "0 3px",
                      lineHeight: 1,
                      opacity: expandedId === p.id ? 1 : (isHover ? 1 : 0.5),
                      transition: "opacity 0.15s, color 0.15s",
                    }}
                  >
                    {expandedId === p.id ? "▾" : "▸"}
                  </span>
                )}
                {isHover && !isRenamingThis && (
                  <span
                    onMouseDown={(e) => { e.stopPropagation(); }}
                    onClick={(e) => { e.stopPropagation(); onRemoveProject(p.id); }}
                    title="Remove session"
                    style={{
                      color: FG_FAINT,
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "0 2px",
                      lineHeight: 1,
                    }}
                    onMouseOver={(e) => (e.currentTarget.style.color = "var(--phn-danger, #e08784)")}
                    onMouseOut={(e) => (e.currentTarget.style.color = FG_FAINT)}
                  >
                    ×
                  </span>
                )}
                </>
                )}
              </div>
              {!collapsed && isExpanded && (
                <div style={{ padding: "2px 0 6px 28px", borderLeft: `1px solid ${BORDER}`, marginLeft: 13 }}>
                  {recentFiles[p.id] === undefined ? (
                    <div style={{ color: FG_FAINT, fontSize: 10, padding: "3px 8px", fontStyle: "italic" }}>loading…</div>
                  ) : recentFiles[p.id].length === 0 ? (
                    <div style={{ color: FG_FAINT, fontSize: 10, padding: "3px 8px" }}>No recent files</div>
                  ) : (
                    recentFiles[p.id].map(f => (
                      <div
                        key={f}
                        title={f}
                        style={{
                          color: FG_DIM,
                          fontSize: 10,
                          padding: "2px 8px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {f}
                      </div>
                    ))
                  )}
                </div>
              )}
              </div>
            );
          };

          // Group sessions into collapsible folders; ungrouped sessions render
          // at the root. Collapsed-rail mode skips folders (just shows dots).
          if (collapsed) return visibleProjects.map(renderRow);
          const order = [];
          const byFolder = new Map();
          const root = [];
          for (const p of visibleProjects) {
            if (p.folder) {
              if (!byFolder.has(p.folder)) { byFolder.set(p.folder, []); order.push(p.folder); }
              byFolder.get(p.folder).push(p);
            } else {
              root.push(p);
            }
          }
          const folders = order.map((name) => {
            const isCol = collapsedFolders.has(name);
            const rows = byFolder.get(name);
            return (
              <div key={`folder:${name}`}>
                <div
                  className="phn-folder-header"
                  onClick={() => toggleFolder(name)}
                  title={isCol ? `Expand "${name}"` : `Collapse "${name}"`}
                >
                  <span className="phn-folder-chevron">{isCol ? "▸" : "▾"}</span>
                  <span className="phn-folder-icon">{folderGlyph(name)}</span>
                  <span className="phn-folder-name">{name}</span>
                  <span className="phn-folder-count">{rows.length}</span>
                </div>
                {!isCol && <div className="phn-folder-body">{rows.map(renderRow)}</div>}
              </div>
            );
          });
          // MobaXterm "User sessions" tree root — categories + loose sessions nest under it.
          // Flush groups (Production / Agents / Local), no "User sessions" root —
          // matches the mockup's tree.
          return (
            <>
              {folders}
              {root.map(renderRow)}
            </>
          );
        })()}
      </div>

      {ctxMenu && (() => {
        const project = projects.find(p => p.id === ctxMenu.projectId);
        if (!project) return null;
        const allFolders = [...new Set(projects.map((p) => p.folder).filter(Boolean))];
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx(); }} />
            <div
              style={{
                position: "fixed",
                left: Math.min(ctxMenu.x, window.innerWidth - 200),
                top: Math.min(ctxMenu.y, window.innerHeight - 220),
                width: 190,
                background: HEADER_BG,
                border: `1px solid ${BORDER}`,
                borderRadius: 4,
                padding: 6,
                zIndex: 9999,
                boxShadow: "0 6px 18px rgba(0,0,0,0.55)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => { onEditProject(project.id); closeCtx(); }}
                style={ctxBtnStyle()}
              >
                Edit session…
              </button>

              {!isSsh(project) && project.path && onNewWorktreeAgent && (
                <button
                  onClick={() => { onNewWorktreeAgent(project.id); closeCtx(); }}
                  style={{ ...ctxBtnStyle(), color: "#7fbf8a" }}
                  title="Spawn an agent in a fresh git worktree (isolated branch + dir) for parallel work"
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SAgents size={12} /> New agent (git worktree)</span>
                </button>
              )}

              <div style={{ padding: "6px 4px 4px", color: FG_DIM, fontSize: 9, letterSpacing: 0.6 }}>COLOR</div>
              <div style={{ display: "flex", gap: 4, padding: "0 4px 6px" }}>
                {COLOR_PALETTE.map(c => (
                  <span
                    key={c.id}
                    onClick={() => { onColorProject(project.id, c.id); closeCtx(); }}
                    title={c.id}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                      background: c.hex,
                      cursor: "pointer",
                      border: project.color === c.id ? `2px solid #fff` : `1px solid ${BORDER}`,
                      boxSizing: "border-box",
                    }}
                  />
                ))}
                <span
                  onClick={() => { onColorProject(project.id, null); closeCtx(); }}
                  title="Clear color"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    background: "transparent",
                    cursor: "pointer",
                    border: `1px dashed ${FG_FAINT}`,
                    boxSizing: "border-box",
                    color: FG_FAINT,
                    fontSize: 11,
                    lineHeight: "12px",
                    textAlign: "center",
                  }}
                >×</span>
              </div>

              {(allFolders.length > 0 || project.folder) && (
                <>
                  <div style={{ height: 1, background: BORDER, margin: "4px 0" }} />
                  <div style={{ padding: "6px 4px 4px", color: FG_DIM, fontSize: 9, letterSpacing: 0.6 }}>FOLDER</div>
                  {allFolders.map((f) => (
                    <button
                      key={f}
                      onClick={() => { onSetFolder?.(project.id, f); closeCtx(); }}
                      style={ctxBtnStyle()}
                      title={`Move "${project.name}" into the "${f}" folder`}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{project.folder === f ? "✓" : <SFolder size={12} />} {f}</span>
                    </button>
                  ))}
                  {project.folder && (
                    <button
                      onClick={() => { onSetFolder?.(project.id, null); closeCtx(); }}
                      style={ctxBtnStyle()}
                      title="Move this session out of its folder"
                    >
                      ⤺ Remove from folder
                    </button>
                  )}
                  <div style={{ color: FG_FAINT, fontSize: 9, padding: "3px 8px 2px", lineHeight: 1.4 }}>
                    New folders: set a folder name in “Edit session…”.
                  </div>
                </>
              )}

              {npmScripts[project.id] && npmScripts[project.id].length > 0 && (
                <>
                  <div style={{ height: 1, background: BORDER, margin: "4px 0" }} />
                  <div style={{ padding: "6px 4px 4px", color: FG_DIM, fontSize: 9, letterSpacing: 0.6 }}>RUN NPM SCRIPT</div>
                  <div style={{ maxHeight: 160, overflowY: "auto" }}>
                    {npmScripts[project.id].slice(0, 12).map(name => (
                      <button
                        key={name}
                        onClick={() => { onRunScript?.(project.id, name); closeCtx(); }}
                        style={{ ...ctxBtnStyle(), color: ACCENT }}
                        title={`Spawn a tab in the active panel running 'npm run ${name}'`}
                      >
                        ▶ {name}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {((isSsh(project) && (project.connection?.auth?.method || "password") === "password") ||
                project.type === "rdp" || project.type === "vnc" || project.rdp || project.vnc) && (
                <button
                  onClick={() => { onForgetPassword?.(project); closeCtx(); }}
                  style={ctxBtnStyle()}
                  title={project.rdp || project.vnc || project.type === "rdp" || project.type === "vnc"
                    ? "Clear this session's password from memory"
                    : "Delete this session's saved password from the keychain"}
                >
                  Forget saved password
                </button>
              )}

              <div style={{ height: 1, background: BORDER, margin: "4px 0" }} />
              <button
                onClick={() => { onRemoveProject(project.id); closeCtx(); }}
                style={{ ...ctxBtnStyle(), color: "#F87171" }}
              >
                Remove
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
}

function ctxBtnStyle() {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: FG,
    padding: "5px 8px",
    fontFamily: M,
    fontSize: 11,
    cursor: "pointer",
    borderRadius: 3,
  };
}

// Memoized so a TerminalsTab re-render (e.g. the 5s sysStats poll or per-token
// cost telemetry) skips re-rendering the sidebar when its props are unchanged.
// Relies on stable function props from the parent (the handlers below are
// useCallback-wrapped in TerminalsTab; the inline arrow props are stabilized via
// useCallback there too).
export default memo(ProjectSidebar);
