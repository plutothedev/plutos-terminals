import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./terminals.css";

const SIDEBAR_BG = "#0d0d0d";
const HEADER_BG = "#181818";
const FG = "#CCCCCC";
const FG_DIM = "#9D9D9D";
const FG_FAINT = "#555555";
const ACCENT = "#4DAAFC";
const BORDER = "#2B2B2B";
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

export default function ProjectSidebar({
  projects,
  projectActivities,
  onClickProject,
  onAddProject,
  onRemoveProject,
  onEditProject,
  onColorProject,
  onRenameProject,
  onDropProject,
  onRunScript,
}) {
  const [hoverId, setHoverId] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null); // {x, y, projectId}
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);

  // Git branch + dirty state per project. Fetched on mount and whenever
  // the projects list changes; refreshed every 30s while the sidebar
  // is open so it tracks user-side branch switches without restart.
  const [gitStatus, setGitStatus] = useState({}); // {projectId: {branch, dirty} | null}
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      projects.forEach(p => {
        if (!p.path) return;
        invoke("git_branch_status", { cwd: p.path })
          .then(status => {
            if (cancelled) return;
            setGitStatus(prev => ({ ...prev, [p.id]: status || null }));
          })
          .catch(() => {});
      });
    };
    refresh();
    const t = setInterval(refresh, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [projects]);

  // npm scripts per project. Lazily fetched when the right-click menu opens.
  const [npmScripts, setNpmScripts] = useState({}); // {projectId: string[]}

  // Recent files per project. Fetched on first expand; cached for the session.
  const [recentFiles, setRecentFiles] = useState({}); // {projectId: string[]}
  const [expandedId, setExpandedId] = useState(null); // only one project expanded at a time

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

  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: SIDEBAR_BG,
        borderRight: `1px solid ${BORDER}`,
        fontFamily: M,
        fontSize: 11,
        color: FG,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 8px 6px 10px",
          background: HEADER_BG,
          borderBottom: `1px solid ${BORDER}`,
          minHeight: 32,
          boxSizing: "border-box",
        }}
      >
        <span style={{ flex: 1, color: FG_DIM, letterSpacing: 0.5, fontSize: 10 }}>PROJECTS</span>
        <button
          onClick={onAddProject}
          title="Add project"
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
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {projects.length === 0 ? (
          <div style={{ padding: "28px 16px", color: FG_FAINT, textAlign: "center", fontSize: 11, lineHeight: 1.5 }}>
            <div style={{ fontSize: 24, marginBottom: 12, opacity: 0.6 }}>📁</div>
            <div style={{ marginBottom: 14, color: FG_DIM }}>
              No projects yet.<br />Add a folder to start running agents.
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
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(77,170,252,0.1)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              + Add project
            </button>
          </div>
        ) : (
          projects.map(p => {
            const isHover = hoverId === p.id;
            const isRenamingThis = renamingId === p.id;
            const isExpanded = expandedId === p.id;
            const activity = projectActivities?.[p.id];
            const nameColor = activity === "active" ? ACTIVE_FG : activity === "done" ? DONE_FG : FG;
            const dotShadow = activity === "active"
              ? `0 0 6px ${ACTIVE_FG}`
              : activity === "done"
                ? `0 0 6px ${DONE_FG}`
                : "none";
            return (
              <div key={p.id}>
              <div
                className={shakingIds.has(p.id) ? "tg-shake" : undefined}
                onMouseDown={(e) => { if (!isRenamingThis) handleRowMouseDown(p, e); }}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(p); }}
                onContextMenu={(e) => handleRowContextMenu(p, e)}
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId(null)}
                title={isRenamingThis ? "Editing — press Enter to save, Esc to cancel" : `${p.path} (double-click to rename)`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 10px",
                  cursor: isRenamingThis ? "text" : "pointer",
                  background: isHover ? "rgba(255,255,255,0.04)" : "transparent",
                  userSelect: "none",
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
                    {gitStatus[p.id] && (
                      <span
                        style={{
                          flexShrink: 0,
                          color: FG_FAINT,
                          fontSize: 9,
                          letterSpacing: 0.3,
                          maxWidth: 70,
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
                    )}
                  </div>
                )}
                {!isRenamingThis && (
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
                    title="Remove project"
                    style={{
                      color: FG_FAINT,
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "0 2px",
                      lineHeight: 1,
                    }}
                    onMouseOver={(e) => (e.currentTarget.style.color = "#f44")}
                    onMouseOut={(e) => (e.currentTarget.style.color = FG_FAINT)}
                  >
                    ×
                  </span>
                )}
              </div>
              {isExpanded && (
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
          })
        )}
      </div>

      {ctxMenu && (() => {
        const project = projects.find(p => p.id === ctxMenu.projectId);
        if (!project) return null;
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
                Edit project…
              </button>

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
