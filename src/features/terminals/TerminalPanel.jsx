import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@backend";
import TerminalPane, { todayDate, transcriptName } from "./TerminalPane";
import { PaneBoundary } from "../../components/ErrorBoundary.jsx";
import VncView from "./VncView";
import RdpView from "./RdpView";
import MobaHomeScreen from "./MobaHomeScreen";
import NotebookView from "./NotebookView";
import ShareModal from "./ShareModal.jsx";
import { getLayout, leafIds, isLeaf } from "./splitTree";
import { resolveActivePaneId } from "./activePane.js";
import { SSplitRow, SSplitCol } from "./toolbarIcons.jsx";
import { dropZone, zoneToSplit, zonePreviewRect } from "./splitDropZones.js";
import { isSpecialTab } from "./paneIds.js";
import { mergeActivity } from "./hooks/useTabTelemetry.js";
import { getPaneActivity, usePanelActivityStamp } from "./activityStore.js";
import { armTabStripFocus, releaseTabStripFocus } from "./tabStripFocus.js";
import "./terminals.css";

// Colors come from the active app skin via CSS vars on <html>. Module-level
// fallback constants are used by drag-ghost helpers and as defaults if vars
// haven't been injected yet (first paint pre-mount). Component reads
// xtermTheme.background for the panel bg so the active tab's bg seamlessly
// merges with the terminal output area below.
const STRIP_BG = "var(--phn-surface-bg, rgba(17,17,17,0.95))";
const BORDER_DIM = "var(--phn-surface-border, rgba(255,255,255,0.08))";
const TAB_FG = "var(--phn-text-fg, #9D9D9D)";
const TAB_FG_ACTIVE = "var(--phn-text-active, #E6E6E6)";
// Alpha washes composite from a per-skin RGB TRIPLE instead of a hardcoded white
// one: 255,255,255 in all twelve dark skins, 0,0,0 in moba-light and daylight
// (headerSkins.css, COMPONENT-LITERAL SET). Each site keeps its own alpha, so
// every call below resolves to the exact rgba(255,255,255,α) literal it replaced
// on all twelve dark skins, and inverts on the two light ones. The previous
// attempt used --phn-hover-bg, which carries one fixed 0.05/0.06 alpha, so it
// restyled these sites on all fourteen skins to fix two.
const wash = (a) => `rgba(var(--phn-wash-rgb, 255,255,255), ${a})`;
// Maximum-contrast ink: #ffffff on every dark skin, which is exactly what these
// sites hardcoded, and near-black on the two light ones. NOT --phn-text-active,
// which is the skin's own emphasis colour (#00fff7 on neon, #ffb000 on amber,
// #eceef0 on moba) and would retint ten dark skins to fix two light ones.
const INK = "var(--phn-ink, #ffffff)";
const ACCENT = "var(--phn-link, #7c9cf5)";
const ACCENT_FALLBACK = "#7c9cf5"; // for drag ghost (DOM-built outside React)
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// A11Y-11, the tab-colour swatch ring. Exported so the contract is testable
// without asking a DOM to substitute custom properties, which neither happy-dom
// nor jsdom does (same reasoning as headerSkins.tokens.test.js).
//
// The requirement is that SELECTED and UNSELECTED stay apart in all fourteen
// skins, and no single pair of colour tokens can promise that: the pass before
// this one used --phn-text-active against --phn-surface-border, which are both
// #ffffff under `brutal`, collapsing the two states into one ring there and
// most of the way to one under `amber` and `crt`. So the pair carries a
// NON-COLOUR cue as well (2px opaque against 1px at 25%) and the colours ride
// --phn-ink / --phn-wash-rgb, which are #ffffff / 255,255,255 on all twelve
// dark skins (byte-identical to the literals this replaced) and near-black /
// 0,0,0 on moba-light and daylight.
//
// The clear-colour swatch keeps a literal mid grey: it is the one value that
// survives inversion, at 4.6:1 on the light menu and 3.3:1 on the dark one.
export function swatchRing(color, appliedColor) {
  if (!color) return "1px solid #777";
  return color === appliedColor ? `2px solid ${INK}` : `1px solid ${wash(0.25)}`;
}
// The ✕ inside the clear-colour swatch. Deliberately NOT --phn-text-dim: that
// swap was never asked for and took the DEFAULT skin's glyph from 6.23:1 to
// 2.38:1 on its own #181818 menu, under the 3:1 floor an icon has to clear.
export const SWATCH_CLEAR_GLYPH = "#999";

// transcriptName (the "<project-or-tab>-<last6ofTabId>" stem) is imported from
// TerminalPane, the write side, so the read side can't silently drift from it.

// Activity colors mirror Moon Dev: yellow while running, green when finished.
const DOT_ACTIVE = "#FBBF24";
const DOT_DONE = "var(--phn-success, #34D399)";
const GLOW_ACTIVE = "rgba(251,191,36,0.45)";
const GLOW_DONE = "rgba(52,211,153,0.55)";
const GLOW_ACTIVE_SHADOW = "0 0 0 1px rgba(251,191,36,0.25), 0 0 10px rgba(251,191,36,0.15)";
const GLOW_DONE_SHADOW = "0 0 0 1px rgba(52,211,153,0.45), 0 0 12px rgba(52,211,153,0.25)";

// Floating drag preview for tab moves. Mirrors the project-drag ghost.
function makeTabGhost(label) {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed","top:0","left:0",
    "pointer-events:none","z-index:99999",
    `background:${ACCENT_FALLBACK}`,"color:#001",
    "padding:3px 9px","border-radius:3px",
    `font:11px/1 ${M}`,"font-weight:600",
    "box-shadow:0 4px 12px rgba(0,0,0,0.55)",
    "white-space:nowrap","transform:translate(-9999px,-9999px)",
  ].join(";");
  el.textContent = `↪ ${label}`;
  document.body.appendChild(el);
  return el;
}
function clearTabDropHighlights() {
  document.querySelectorAll("[data-panel-id][data-tab-drop='1']").forEach(el => {
    el.removeAttribute("data-tab-drop");
    el.style.outline = "";
    el.style.outlineOffset = "";
  });
}
function highlightTabDrop(el) {
  if (!el || el.getAttribute("data-tab-drop") === "1") return;
  el.setAttribute("data-tab-drop", "1");
  el.style.outline = `2px solid ${ACCENT_FALLBACK}`;
  el.style.outlineOffset = "-2px";
}
// In-strip reorder: an insertion bar on the target tab's left/right edge.
function clearTabInserts() {
  document.querySelectorAll(".moba-tab.tab-drop-before, .moba-tab.tab-drop-after").forEach(el => {
    el.classList.remove("tab-drop-before", "tab-drop-after");
  });
}
function markTabInsert(el, after) {
  if (el) el.classList.add(after ? "tab-drop-after" : "tab-drop-before");
}

// Activity for a single tab = the "loudest" of its panes (active > done > idle).
// Both rollups go through the shared mergeActivity (waiting > active > done >
// idle) so the tab dot, the panel dot, the project row and the agent dashboard
// can never disagree about what a session is doing. Reads come straight from
// the activity store (P2-T1) inside a render the panel's own leaf-set
// subscription triggered — no map prop, no app-wide identity churn.
function aggregateTabActivity(tab) {
  let best = "idle";
  for (const id of leafIds(getLayout(tab))) {
    best = mergeActivity(best, getPaneActivity(id));
    if (best === "waiting") break;
  }
  return best;
}

function aggregatePanelActivity(panel) {
  let best = "idle";
  for (const t of panel.tabs) {
    best = mergeActivity(best, aggregateTabActivity(t));
    if (best === "waiting") break;
  }
  return best;
}

// Walk a tab's split tree into a flat list of pane rects (percentages of the
// tab's pane area) + divider descriptors. Flat + percentage-positioned so a
// split/close/resize only moves existing panes (CSS) — it never restructures
// the React tree, so a live pane's PTY is never remounted. `dragRatios`
// overrides a split's stored ratio while its divider is being dragged (local,
// un-persisted) for smooth resizing.
function computeLayout(node, dragRatios, rect = { left: 0, top: 0, width: 100, height: 100 }) {
  if (isLeaf(node)) return { panes: [{ node, rect }], dividers: [] };
  const ratio = dragRatios[node.id] != null ? dragRatios[node.id] : node.ratio;
  const isRow = node.dir === "row";
  let aRect, bRect;
  if (isRow) {
    const w = rect.width * ratio;
    aRect = { left: rect.left, top: rect.top, width: w, height: rect.height };
    bRect = { left: rect.left + w, top: rect.top, width: rect.width - w, height: rect.height };
  } else {
    const h = rect.height * ratio;
    aRect = { left: rect.left, top: rect.top, width: rect.width, height: h };
    bRect = { left: rect.left, top: rect.top + h, width: rect.width, height: rect.height - h };
  }
  const A = computeLayout(node.a, dragRatios, aRect);
  const B = computeLayout(node.b, dragRatios, bRect);
  return {
    panes: [...A.panes, ...B.panes],
    dividers: [{ splitId: node.id, dir: node.dir, container: rect, ratio }, ...A.dividers, ...B.dividers],
  };
}

// ── Tab-strip focus helpers ─────────────────────────────────────────────────
// Module scope rather than component scope: the tab context menu's Escape
// listener below is a window listener that subscribes once per OPEN, and a
// helper rebuilt on every render would force it to re-subscribe on every render
// of the panel underneath the open menu. Both are pure DOM, so there is nothing
// from a render for them to capture.
//
// The strip for a node that is NOT inside it. The tab context menu is a
// fixed-position SIBLING of the strip, so `closest(".moba-tabstrip")` from
// inside it finds nothing; going up to the panel root first also guarantees
// a second panel's strip can never be the answer.
const stripFor = (el) => el?.closest("[data-panel-id]")?.querySelector(".moba-tabstrip") || null;
const focusTabIn = (strip, id) => {
  if (!strip || !id) return;
  // Every caller is a KEYSTROKE deliberately placing focus on a tab, so this
  // is also where the pane's reveal-focus steal is waved off. Without it the
  // switch this focus call belongs to reveals the target pane, and 30ms later
  // TerminalPane's reveal effect focuses its xterm and the next arrow key is
  // typing into a live shell (see tabStripFocus.js for the measurement).
  armTabStripFocus();
  // Match on dataset rather than an attribute selector: tab ids are
  // generated strings and CSS.escape is not worth the dependency here.
  for (const el of strip.querySelectorAll(".moba-tab")) {
    if (el.dataset.tabId === id) { el.focus(); return; }
  }
};

// ── Tab context menu: the keyboard model (audit A11Y-12) ────────────────────
// The menu is a real ARIA menu — role="menu" over menuitem / menuitemradio
// children, arrows between items, Escape or Tab to leave. It previously
// announced plain buttons and could only be walked with Tab, which was also the
// one key that carried focus OUT of it while it stayed open.
const MENU_ITEM_SEL = '[role="menuitem"],[role="menuitemradio"]';
// Enabled items, in DOM order. `disabled` buttons are dropped because a
// disabled button cannot take focus, so stepping onto one would drop focus to
// <body> — the exact failure this change exists to remove.
function menuItemsIn(node) {
  return Array.from(node.querySelectorAll(MENU_ITEM_SEL)).filter((el) => !el.disabled);
}
// The vertical ring. The eight colour swatches are one HORIZONTAL row, so they
// contribute a single stop to Up/Down (the applied colour, else the first) and
// are walked with Left/Right instead. A flat ring would spend eight Down
// presses crossing a strip that reads as one control.
function menuRowsIn(items) {
  const swatches = items.filter((el) => el.getAttribute("role") === "menuitemradio");
  const entry = swatches.find((el) => el.getAttribute("aria-checked") === "true") || swatches[0];
  return items.filter((el) => el.getAttribute("role") !== "menuitemradio" || el === entry);
}

function TerminalPanel({
  panel,
  isActive,
  canClosePanel,
  xtermTheme,
  promptEditor,
  promptEditorVim,
  tabAutoApprove,
  tabProjectNames,
  paneTitles,           // paneId -> display title (NotebookView's target-pane picker)
  saveUser = () => {},  // functional user-store writer, threaded to TerminalPane's ShareModal
  notify = () => {},    // stable toast bridge (variant, message); see TerminalsTab. Keeps this memo'd tree off the toast context
  homeApi,
  onActivate,
  onAddTab,
  onCloseTab,
  onSwitchTab,
  onClosePanel,
  onTabCostUpdate,
  onRenameTab,
  onSetTabColor,
  onDuplicateTab,
  onDetachTab,
  onCloseOthers,
  onMoveTab,
  onReorderTab,
  onSplitDropTab,
  onSplitPane,
  onClosePane,
  onActivatePane,
  onSetPaneRatio,
}) {
  // Bind this panel's id onto the parent's stable (panelId-first) callbacks so
  // the parent passes stable references and React.memo (below) can skip
  // re-rendering this panel when unrelated TerminalsTab state changes (the 2.5s
  // sysStats poll, modal toggles, dock resize, …). Re-renders still happen when
  // the panel object, activity/cost, or theme actually change.
  const h = useMemo(() => ({
    activate: () => onActivate(panel.id),
    addTab: () => onAddTab(panel.id),
    closeTab: (tabId) => onCloseTab(panel.id, tabId),
    switchTab: (tabId) => onSwitchTab(panel.id, tabId),
    closePanel: () => onClosePanel(panel.id),
    duplicate: (tabId) => onDuplicateTab(panel.id, tabId),
    detach: (tabId) => onDetachTab(panel.id, tabId),
    closeOthers: (tabId) => onCloseOthers(panel.id, tabId),
  }), [panel.id, onActivate, onAddTab, onCloseTab, onSwitchTab, onClosePanel, onDuplicateTab, onDetachTab, onCloseOthers]);

  // Per-pane cost handlers with PERMANENT identities (P2-T2): the old inline
  // arrow re-minted per render, which would defeat memo(TerminalPane). The
  // latest onTabCostUpdate rides a ref; stale ids are pruned when the leaf
  // set changes.
  const onTabCostUpdateRef = useRef(onTabCostUpdate);
  onTabCostUpdateRef.current = onTabCostUpdate;
  const costHandlersRef = useRef(new Map());
  const costHandlerFor = (paneId) => {
    let h = costHandlersRef.current.get(paneId);
    if (!h) {
      h = (c) => onTabCostUpdateRef.current?.(paneId, c);
      costHandlersRef.current.set(paneId, h);
    }
    return h;
  };

  const activeTab = panel.tabs.find(t => t.id === panel.activeTabId) || panel.tabs[0];
  // Subscribe to THIS panel's leaf set only (P2-T1): an activity flip in one
  // of our panes re-renders this panel's strip; flips elsewhere don't touch
  // us. The stamp is a primitive, so unchanged sets never re-render.
  const leafKey = useMemo(
    () => panel.tabs.flatMap((t) => leafIds(getLayout(t))).join(","),
    [panel.tabs]
  );
  usePanelActivityStamp(leafKey);
  useEffect(() => {
    const live = new Set(leafKey ? leafKey.split(",") : []);
    for (const id of [...costHandlersRef.current.keys()]) {
      if (!live.has(id)) costHandlersRef.current.delete(id);
    }
  }, [leafKey]);
  const panelState = aggregatePanelActivity(panel);

  // Panel bg = xterm bg so the active tab visually merges with the terminal
  // output area below. Falls back to dark if no xterm theme provided yet.
  const PANEL_BG = xtermTheme?.background || "#0a0a0a";

  // Inline rename state — only one tab in a panel can be renamed at a time.
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);
  // Hovered tab — drives the hover-only close button (Termius style).
  const [hoverTabId, setHoverTabId] = useState(null);
  // Right-click tab context menu: { x, y, tabId } or null.
  const [tabCtxMenu, setTabCtxMenu] = useState(null);

  // Share preview target for the tab menu's "Share transcript" (Stream D). A
  // per-panel ShareModal opened from the tab context menu with the whole-session
  // transcript, mirroring TerminalPane's block-share flow. null = closed.
  const [shareTarget, setShareTarget] = useState(null);

  // "Share transcript": read the whole session transcript for the tab's ACTIVE
  // PANE (all dated files concatenated, oldest first) and open the share
  // preview. An empty / whitespace-only or unreadable transcript means nothing
  // was recorded, so just notify and open no modal (fail-closed: nothing leaves).
  //
  // Pane-addressed, not tab-addressed (audit FE-1). TerminalPane writes its
  // transcript under its own LEAF id (`transcriptName(liveProjectName(),
  // tabIdRef.current)`), and the project-name half only reaches the ROOT leaf
  // (`projectName={isRoot ? … : null}` below), so the stem has to be rebuilt
  // from the resolved pane under the same isRoot rule. Keyed on tab.id this
  // could only ever share pane 1 of a split, and once the ORIGINAL pane was
  // closed (removeLeaf collapses to the sibling, leaving no leaf whose id
  // equals tab.id) it either claimed "Nothing recorded yet." for a tab with a
  // live shell, or served the DEAD pane's on-disk history as the live one's.
  const shareTranscript = async (tab) => {
    const paneId = resolveActivePaneId(tab);
    const name = transcriptName(paneId === tab.id ? (tabProjectNames?.[tab.id] || null) : null, paneId);
    let rawText = "";
    try {
      rawText = await invoke("transcript_read_all", { name });
    } catch {
      rawText = "";
    }
    if (!rawText || !rawText.trim()) {
      notify("info", "Nothing recorded yet.");
      return;
    }
    setShareTarget({ kind: "transcript", title: tab.label || "transcript", rawText, dateStamp: todayDate() });
  };

  // Transient divider ratios during an active drag, keyed by splitId. Kept out
  // of app state so a drag doesn't hammer localStorage; committed on mouseup.
  const [dragRatios, setDragRatios] = useState({});
  const [zoomedPaneId, setZoomedPaneId] = useState(null); // pane zoomed to fill its tab
  // Abort an in-flight tab/divider drag on unmount so document mousemove/mouseup
  // listeners (and, for tab-drag, the floating ghost + drop highlights) never
  // outlive the panel (audit L1). Each handler stores its AbortController here.
  const dragAbortRef = useRef(null);
  useEffect(() => () => dragAbortRef.current?.abort(), []);

  // Tab drag between panels. Mouse-event based (HTML5 drag is broken in
  // WebView2 per the code-rule memo). On drop over a different panel, the
  // tab is moved via onMoveTab — the live terminal survives the move (the
  // pane registry re-parents the same xterm+PTY into the target panel).
  const handleTabMouseDown = (tab, e) => {
    // The mouse always wins. A click on a tab has always ended with the caret
    // in that tab's shell, and it still does even when it lands inside the
    // half-second window a preceding arrow key opened. Before the button check
    // on purpose: a right-click hands over too.
    releaseTabStripFocus();
    if (e.button !== 0) return;
    if (renamingId === tab.id) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let ghost = null;
    let lastTargetEl = null;
    let dropIndex = null; // in-strip reorder target, when dragging over our own panel
    // Pane-edge split targeting (drag a tab onto a pane's edge). Only plain
    // local terminal tabs may fold into another tab's layout: leaves don't
    // carry connection/serial config, so a merged remote tab would silently
    // respawn as a local shell after an app restart (see moveTabIntoSplit).
    // Ineligible tabs keep the classic move-to-panel drop everywhere.
    const canSplitDrop = !isSpecialTab(tab) && !tab.connection && !tab.serial;
    let splitDrop = null; // {targetTabId, targetPaneId, dir, newFirst} while over an edge zone
    let dropPreviewEl = null;
    const clearSplitPreview = () => {
      if (dropPreviewEl) { dropPreviewEl.remove(); dropPreviewEl = null; }
      splitDrop = null;
    };
    const showSplitPreview = (paneEl, zone) => {
      if (!dropPreviewEl || dropPreviewEl.parentElement !== paneEl) {
        if (dropPreviewEl) dropPreviewEl.remove();
        dropPreviewEl = document.createElement("div");
        dropPreviewEl.className = "phn-split-drop";
        paneEl.appendChild(dropPreviewEl);
      }
      Object.assign(dropPreviewEl.style, zonePreviewRect(zone));
    };
    const onMove = (ev) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (!dragging && (dx > 5 || dy > 5)) {
        dragging = true;
        ghost = makeTabGhost(tab.label);
      }
      if (dragging && ghost) {
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        // Edge zones on a visible pane win over strip/panel targeting; the
        // center zone falls through to the classic behaviors below.
        splitDrop = null;
        const paneEl = canSplitDrop ? el?.closest("[data-pane-id]") : null;
        if (paneEl && paneEl.dataset.paneTabId && paneEl.dataset.paneTabId !== tab.id) {
          const zone = dropZone(ev.clientX, ev.clientY, paneEl.getBoundingClientRect());
          const split = zoneToSplit(zone);
          if (split) {
            splitDrop = {
              targetTabId: paneEl.dataset.paneTabId,
              targetPaneId: paneEl.dataset.paneId,
              ...split,
            };
            showSplitPreview(paneEl, zone);
          }
        }
        if (!splitDrop && dropPreviewEl) { dropPreviewEl.remove(); dropPreviewEl = null; }
        if (splitDrop) {
          clearTabDropHighlights();
          clearTabInserts();
          dropIndex = null;
          lastTargetEl = null;
          return;
        }
        const panelEl = el?.closest("[data-panel-id]");
        const tgtPanelId = panelEl?.getAttribute("data-panel-id");
        const isOwn = tgtPanelId === panel.id;
        if (panelEl !== lastTargetEl) {
          clearTabDropHighlights();
          if (panelEl && !isOwn) highlightTabDrop(panelEl);
          lastTargetEl = panelEl || null;
        }
        // Over our own panel → reorder: show an insertion bar on the tab under the
        // cursor (left/right half decides before/after) and remember the index.
        clearTabInserts();
        dropIndex = null;
        if (isOwn) {
          const tabEl = el?.closest(".moba-tab");
          if (tabEl && tabEl.dataset.tabId) {
            const r = tabEl.getBoundingClientRect();
            const after = ev.clientX > r.left + r.width / 2;
            const overIdx = panel.tabs.findIndex((t) => t.id === tabEl.dataset.tabId);
            if (overIdx >= 0) { dropIndex = after ? overIdx + 1 : overIdx; markTabInsert(tabEl, after); }
          } else {
            dropIndex = panel.tabs.length; // dropped on the strip past the last tab
          }
        }
      }
    };
    dragAbortRef.current?.abort(); // end any prior drag first
    const ac = new AbortController();
    dragAbortRef.current = ac;
    const { signal } = ac;
    const onUp = () => {
      // Read drop intent BEFORE abort clears the visual state, then commit.
      const pendingSplit = splitDrop;
      const tgt = lastTargetEl?.getAttribute("data-panel-id");
      ac.abort(); // removes listeners + clears ghost/preview/highlights/inserts
      if (dragging && pendingSplit) {
        onSplitDropTab?.(tab.id, pendingSplit.targetTabId, pendingSplit.targetPaneId, pendingSplit.dir, pendingSplit.newFirst);
      } else if (dragging && tgt && tgt !== panel.id) {
        onMoveTab?.(tab.id, tgt);
      } else if (dragging && dropIndex != null) {
        // Reorder within our strip. Removing the dragged tab shifts indices to its
        // right, so drop targets past the origin move back by one.
        const from = panel.tabs.findIndex((t) => t.id === tab.id);
        const to = dropIndex > from ? dropIndex - 1 : dropIndex;
        if (to !== from) onReorderTab?.(tab.id, to);
      }
    };
    // Teardown reached by mouseup AND unmount-mid-drag: drop the floating ghost
    // and every drop-target highlight so nothing is stranded on screen (L1).
    signal.addEventListener("abort", () => {
      if (ghost) ghost.remove();
      clearSplitPreview();
      clearTabDropHighlights();
      clearTabInserts();
    });
    document.addEventListener("mousemove", onMove, { signal });
    document.addEventListener("mouseup", onUp, { signal });
  };

  // Divider drag. The divider's parent is the tab's pane-area element, so its
  // bounding rect gives the pixel size to convert a cursor position into a
  // ratio. We preview via local state and commit once on release.
  const handleDividerMouseDown = (divider, tabId, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const areaEl = e.currentTarget.parentElement;
    if (!areaEl) return;
    const isRow = divider.dir === "row";
    const onMove = (ev) => {
      const r = areaEl.getBoundingClientRect();
      const subStart = isRow
        ? r.left + (divider.container.left / 100) * r.width
        : r.top + (divider.container.top / 100) * r.height;
      const subSize = isRow
        ? (divider.container.width / 100) * r.width
        : (divider.container.height / 100) * r.height;
      if (subSize <= 0) return;
      const pos = isRow ? ev.clientX : ev.clientY;
      let ratio = (pos - subStart) / subSize;
      ratio = Math.max(0.1, Math.min(0.9, ratio));
      setDragRatios(prev => ({ ...prev, [divider.splitId]: ratio }));
    };
    dragAbortRef.current?.abort(); // end any prior drag first
    const ac = new AbortController();
    dragAbortRef.current = ac;
    const onUp = () => {
      setDragRatios(prev => {
        const final = prev[divider.splitId];
        if (final != null) onSetPaneRatio?.(tabId, divider.splitId, final);
        const { [divider.splitId]: _drop, ...rest } = prev;
        return rest;
      });
      ac.abort(); // removes both listeners (also fires on unmount-mid-drag)
    };
    document.addEventListener("mousemove", onMove, { signal: ac.signal });
    document.addEventListener("mouseup", onUp, { signal: ac.signal });
  };

  const startRename = (tab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.label || "");
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };
  const commitRename = () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) onRenameTab?.(renamingId, trimmed);
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);
  // Both keyboard exits from the inline rename input (Enter commits, Escape
  // cancels) unmount the input, and a browser does NOT move focus when the
  // focused node is removed: it drops to <body>, so F2, type, Enter left the
  // keyboard user outside every control in the app. Put focus back on the tab
  // they renamed.
  //
  // Deferred a task, not called inline, and that ordering is load-bearing:
  // focusing the tab while the input is still mounted blurs the input, whose
  // onBlur is commitRename, whose `renamingId` guard reads the CURRENT render's
  // value (React has not re-rendered yet), so an inline focus call would make
  // Escape commit the edit it was cancelling. A macrotask runs after React has
  // flushed this discrete event and dropped the input.
  const refocusTabAfterRename = (strip, id) => {
    setTimeout(() => focusTabIn(strip, id), 0);
  };

  // ── Tab-strip keyboard navigation (A11Y-05, DOM half) ───────────────────
  //
  // The strip is a real ARIA tablist with a ROVING tabIndex: exactly one tab
  // is in the document tab order at a time (the selected one), so twenty tabs
  // cost the Tab key one stop, not twenty, and Left/Right move between them.
  //
  // INVARIANT 1 (PTYs survive React) is why this is derived state and not
  // React state. `roving` is computed from `panel.activeTabId`, the same value
  // that already drives the `.active` class, so MOVING FOCUS RE-RENDERS
  // NOTHING: no useState, no useEffect, no ref, nothing React observes. The
  // only re-render in this path is the tab switch itself, which is the exact
  // render a mouse click already produced before this change. Focus is applied
  // to a DOM node that is already mounted and keyed by `tab.id`, so React
  // reconciles it in place; no key, element type, or tree position in the pane
  // area moves. See TerminalPanel.a11y.test.jsx, which mounts the real
  // component and asserts a pane is not remounted across arrow-key tab
  // switches.
  //
  // The strip element is resolved from the event rather than held in a ref:
  // every caller here is a keydown on a node inside the strip, so `closest`
  // already knows the answer, and a ref would put a `.current` read in
  // reachability range of the render tree for no gain.
  const stripOf = (e) => e.currentTarget.closest(".moba-tabstrip");
  // `stripFor` and `focusTabIn` are module scope (top of this file) so the
  // context menu's window-level Escape effect can use them without a dep.
  // Close from the keyboard, keeping focus inside the strip: the neighbour is
  // resolved and focused BEFORE React drops the closed tab, and that neighbour
  // node survives the re-render (same key), so focus never falls to <body>.
  const closeTabFromKeyboard = (tab, strip) => {
    const i = panel.tabs.findIndex((t) => t.id === tab.id);
    const neighbour = panel.tabs[i + 1] || panel.tabs[i - 1];
    h.closeTab(tab.id);
    if (neighbour) focusTabIn(strip, neighbour.id);
  };
  const handleTabKeyDown = (tab, e) => {
    // While renaming, every keystroke belongs to the input nested inside this
    // tab and bubbles through here. Arrow keys must edit text, not move tabs.
    if (renamingId === tab.id) return;
    const tabs = panel.tabs;
    const i = tabs.findIndex((t) => t.id === tab.id);
    if (i < 0) return;
    let target = null;
    switch (e.key) {
      case "ArrowRight": target = tabs[(i + 1) % tabs.length]; break;
      case "ArrowLeft": target = tabs[(i - 1 + tabs.length) % tabs.length]; break;
      case "Home": target = tabs[0]; break;
      case "End": target = tabs[tabs.length - 1]; break;
      case "Enter":
      case " ":
        // A focused <div role="tab"> gets no synthetic click from Enter the
        // way a <button> would, so activation is explicit. Space would scroll
        // the strip's overflow container without the preventDefault.
        e.preventDefault(); e.stopPropagation();
        // Activation moves no focus, so it never reaches focusTabIn, but it
        // DOES reveal a pane, so arm it here or Enter hands the strip's focus to
        // the terminal 30ms later, which is the ARIA opposite of activation.
        armTabStripFocus();
        h.switchTab(tab.id);
        return;
      case "Delete":
        if (tabs.length <= 1) return; // last tab in a panel is not closeable
        e.preventDefault(); e.stopPropagation();
        closeTabFromKeyboard(tab, stripOf(e));
        return;
      case "F2":
        e.preventDefault(); e.stopPropagation();
        startRename(tab);
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (target && target.id !== tab.id) h.switchTab(target.id);
    focusTabIn(stripOf(e), target.id);
  };
  // Context-menu keyboard exit (audit A11Y-12). Making the tabs focusable opened
  // a route into this menu that did not exist before: Chromium dispatches
  // `contextmenu` at the FOCUSED element for the Menu key and Shift+F10, so the
  // keyboard can now open it. Every dismissal it had was mouse-only (the
  // backdrop's onMouseDown / onContextMenu), and the backdrop blocks pointer
  // events, not keys, so with focus still parked on the tab behind it the arrow
  // keys kept switching tabs under an open menu pinned to the id it opened on.
  //
  // The first pass moved focus into the menu and listened for Escape ON THE
  // MENU ELEMENT, which meant the exit died the instant focus left it — and Tab
  // did that in one keypress, since nothing trapped it. Escape is now a WINDOW
  // listener, so it closes the menu from wherever focus has ended up.
  const tabCtxMenuRef = useRef(null);

  // A stable callback ref so React runs it exactly on mount (and once with null
  // on unmount). An inline arrow would be a new function every render and React
  // would re-run it every time the panel re-rendered underneath the open menu,
  // yanking focus back to the first item mid-interaction.
  const mountTabCtxMenu = useCallback((el) => {
    tabCtxMenuRef.current = el;
    el?.querySelector(MENU_ITEM_SEL)?.focus();
  }, []);

  // Close the menu and hand focus back to the tab it was pinned to. The tab id
  // is read off the menu node's own marker attribute rather than captured from
  // a render, which is what keeps this callback stable enough for the effect
  // below to subscribe once per OPEN instead of once per render. Focus first,
  // close second: a browser moves focus NOWHERE when the focused node is
  // removed, so once the state commits it would already have fallen to <body>.
  const dismissTabCtxMenu = useCallback(() => {
    const node = tabCtxMenuRef.current;
    const id = node?.dataset?.tabCtxMenu;
    if (id) focusTabIn(stripFor(node), id);
    setTabCtxMenu(null);
  }, []);

  // Escape, from anywhere. Scoped to the TOPMOST menu the same way Modal.jsx
  // scopes its own Escape to the topmost dialog: read the live DOM at event
  // time, which survives effect re-runs where a counter or a depth prop does
  // not. (The menu sits at z-index 9999, above the 9990 modal overlay, so when
  // both are somehow open the menu is genuinely the layer on top.)
  useEffect(() => {
    if (!tabCtxMenu) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const menus = document.querySelectorAll("[data-tab-ctx-menu]");
      if (menus.length === 0 || menus[menus.length - 1] !== tabCtxMenuRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      dismissTabCtxMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabCtxMenu, dismissTabCtxMenu]);

  // Arrow keys move between items, so Tab no longer has to. Down/Up walk the
  // vertical ring (see menuRowsIn), Left/Right walk the colour row, Home/End
  // jump to the ends, and Tab dismisses: a menu is not part of the document tab
  // sequence, and dismissing on Tab is what makes the trap unreachable rather
  // than merely escapable.
  const onTabCtxMenuKey = (e) => {
    const node = tabCtxMenuRef.current;
    if (!node) return;
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      dismissTabCtxMenu();
      return;
    }
    const horizontal = e.key === "ArrowRight" || e.key === "ArrowLeft";
    const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
    const homeEnd = e.key === "Home" || e.key === "End";
    if (!horizontal && !vertical && !homeEnd) return;
    const active = document.activeElement;
    const onSwatch = active?.getAttribute?.("role") === "menuitemradio";
    // Left/Right belong to the colour row only. Anywhere else in the menu they
    // are somebody else's keys and must not be swallowed.
    if (horizontal && !onSwatch) return;
    const items = menuItemsIn(node);
    if (items.length === 0) return;
    const ring = horizontal
      ? items.filter((el) => el.getAttribute("role") === "menuitemradio")
      : menuRowsIn(items);
    if (ring.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    let i = ring.indexOf(active);
    // Vertical, from a swatch that is not the row's entry stop: treat the row
    // as the current position so Down lands on the item after it, not item one.
    if (i < 0) i = ring.findIndex((el) => el.getAttribute("role") === "menuitemradio");
    if (i < 0) i = 0;
    let next;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ring.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % ring.length;
    else next = (i - 1 + ring.length) % ring.length;
    ring[next].focus();
  };

  // Enter/Space activation for the non-tab controls in the strip (close ✕,
  // new-tab +, close-panel ✕). They stay <span>/<div> rather than becoming
  // <button>: their styling lives in terminals.css, which this change does not
  // own, and a UA button box (buttonface fill, outset border, centred system
  // font) would repaint them on all fourteen skins.
  const activateOnKey = (fn) => (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  };

  // Flat panel framing (mockup 12): a thin neutral border, no glow, no
  // rainbow. The focused panel only gets a blue edge when the grid is split
  // (canClosePanel ⇒ >1 panel), so a single terminal stays clean. Activity is
  // conveyed by the tab dots, not a glowing terminal frame.
  let borderColor = "var(--phn-surface-border, #34383F)";
  const boxShadow = "none";
  if (isActive && canClosePanel) {
    borderColor = "var(--phn-link, #7c9cf5)";
  } else if (!isActive && panelState === "active") {
    borderColor = GLOW_ACTIVE;
  } else if (!isActive && panelState === "done") {
    borderColor = GLOW_DONE;
  }

  const activePaneId = activeTab?.activePaneId || activeTab?.id;
  const activeTabMulti = activeTab ? !isLeaf(getLayout(activeTab)) : false;

  return (
    <div
      data-panel-id={panel.id}
      onMouseDown={h.activate}
      style={{
        display: "flex",
        flexDirection: "column",
        background: PANEL_BG,
        border: `1px solid ${borderColor}`,
        boxShadow,
        borderRadius: 3,
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
    >
      {/* Tab strip. Skins theme it via --phn-tabstrip-bg (moba/oled/moba-light
          + custom themes define it; the old "--phn-surface" here was defined by
          NO skin, so the strip was stuck on the dark fallback — dark-on-white
          under the Light skin). The fallback keeps legacy skins as they were. */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "var(--phn-tabstrip-bg, #24272D)",
          borderBottom: "1px solid var(--phn-surface-border, #34383F)",
          height: 30,
          fontSize: 12,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {/* role="tablist" (A11Y-05). The new-tab + is a non-tab child of the
            list, which is the one ARIA compromise here: it lives INSIDE the
            horizontally-scrolling strip so it sits immediately after the last
            tab, and hoisting it out to the flex:1 parent would park it against
            the far right edge of the panel. It is exposed as a named button
            rather than dropped from the a11y tree. */}
        <div className="moba-tabstrip" role="tablist" aria-label="Terminal tabs" aria-orientation="horizontal" data-tour={isActive ? "tab-strip" : undefined} style={{ display: "flex", flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden", alignItems: "stretch" }}>
          {panel.tabs.map((tab, ti) => {
            const active = tab.id === panel.activeTabId;
            // Roving tabIndex. `active` can be false for EVERY tab if
            // activeTabId is stale, which would leave the strip with no tab
            // stop at all, so the roving flag falls back the same way
            // `activeTab` does (first tab) rather than reusing `active`.
            const roving = tab.id === (activeTab?.id ?? panel.tabs[0]?.id);
            const tabState = aggregateTabActivity(tab);
            const isRenamingThis = renamingId === tab.id;
            const paneCount = leafIds(getLayout(tab)).length;
            const dotBg = tab.color
              ? tab.color
              : tabState === "active" ? DOT_ACTIVE
              : tabState === "done" ? DOT_DONE
              : "var(--phn-text-faint, #586068)";
            return (
              <div
                key={tab.id}
                id={`phn-tab-${tab.id}`}
                data-tab-id={tab.id}
                className={active ? "moba-tab active" : "moba-tab"}
                role="tab"
                aria-selected={active}
                aria-controls={`phn-tabpanel-${tab.id}`}
                // Explicit name. Without it the name is computed from the tab's
                // contents, which would swallow the close button's own label
                // and announce "Terminal 1 ✕ Close Terminal 1".
                aria-label={paneCount > 1 ? `${tab.label}, ${paneCount} panes` : tab.label}
                tabIndex={roving ? 0 : -1}
                onMouseDown={(e) => { handleTabMouseDown(tab, e); }}
                onClick={(e) => { e.stopPropagation(); if (!isRenamingThis) h.switchTab(tab.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); startRename(tab); }}
                onKeyDown={(e) => handleTabKeyDown(tab, e)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTabCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
                onMouseEnter={() => setHoverTabId(tab.id)}
                onMouseLeave={() => setHoverTabId((cur) => (cur === tab.id ? null : cur))}
                // outlineOffset draws the UA focus ring INSIDE the tab. The
                // strip's parent is overflow:hidden at height 30 and the tab is
                // 27px flush to its bottom edge, so a default (offset 0) ring
                // would be clipped along the bottom. No paint changes unless
                // the tab is focused, so all fourteen skins are untouched.
                style={{ cursor: isRenamingThis ? "text" : "pointer", outlineOffset: -2 }}
                title={isRenamingThis ? "Editing: press Enter to save, Esc to cancel" : `${tab.label} (double-click or F2 to rename · Del to close)`}
              >
                {/* Drag-reorder drop bar (audit M6): a positive-z child, not a
                    box-shadow on the tab — the trapezoid ::before/::after fills
                    (z-index:-1) paint ABOVE the tab's own box-shadow and hid it. */}
                <span className="moba-tab-dropbar" aria-hidden="true" />
                <span
                  className={tabState === "active" ? "phn-tab-dot phn-tab-dot-active" : tabState === "done" ? "phn-tab-dot phn-tab-dot-done" : "phn-tab-dot"}
                  // Decorative: the tab carries its own aria-label, and this
                  // dot's title is a mouse tooltip, which aria-hidden leaves
                  // working. Contains nothing focusable.
                  aria-hidden="true"
                  title={tab.home ? "Session launch screen" : tab.worktree ? `Agent worktree (${tab.worktree.branch})` : tab.rdp ? "RDP desktop" : tab.vnc ? "VNC desktop" : tab.notebook ? "Notebook" : tab.connection ? "SSH session" : tab.serial ? "Serial console" : "Local shell"}
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dotBg,
                    flexShrink: 0,
                    boxShadow: tabState === "active"
                      ? `0 0 6px ${DOT_ACTIVE}`
                      : tabState === "done"
                        ? `0 0 7px ${DOT_DONE}`
                        : "none",
                    transition: "background 0.2s, box-shadow 0.2s",
                  }}
                />
                {isRenamingThis ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== "Escape") return;
                      e.preventDefault();
                      // Resolved BEFORE the state change: the input is about to
                      // be unmounted, and a detached node's closest() is null.
                      const strip = e.currentTarget.closest(".moba-tabstrip");
                      if (e.key === "Enter") commitRename();
                      else cancelRename();
                      refocusTabAfterRename(strip, tab.id);
                    }}
                    aria-label="Rename tab"
                    spellCheck={false}
                    style={{
                      // A11Y-03, the white-on-white input. This field paints on
                      // the ACTIVE TAB BODY (--phn-tab-bg-active), not on the
                      // panel, and that is what made it the worst site in the
                      // app: on moba-light the tab body is #ffffff, so an 8%
                      // white wash composited straight back to #ffffff and #fff
                      // text vanished. wash() keeps the identical 0.08 alpha and
                      // only flips which colour it is made of.
                      background: wash(0.08),
                      border: `1px solid ${ACCENT}`,
                      color: INK,
                      fontFamily: "inherit",
                      fontSize: 12,
                      padding: "0 4px",
                      width: Math.max(60, renameValue.length * 7 + 12),
                      // outline:none is kept deliberately: the 1px --phn-link
                      // border above IS this field's focus treatment. The element
                      // only exists while renaming and is focused on mount, so the
                      // border is never absent while focus is here, and it clears
                      // the 3:1 non-text floor in every skin (4.65:1 on daylight,
                      // 4.17:1 on moba-light, 4.00:1 on moba). Dropping
                      // outline:none would add a UA ring the dark skins never had.
                      outline: "none",
                      borderRadius: 2,
                    }}
                  />
                ) : (
                  <span className="moba-tab-label">{tab.label}</span>
                )}
                {paneCount > 1 && !isRenamingThis && (
                  // Already folded into the tab's aria-label above, so hidden
                  // here rather than announced twice.
                  <span aria-hidden="true" title={`${paneCount} panes`} style={{ color: "var(--phn-text-faint, #586068)", fontSize: 9, flexShrink: 0 }}>
                    ⊞{paneCount}
                  </span>
                )}
                {panel.tabs.length > 1 && !isRenamingThis && (
                  <span
                    className="moba-tab-x"
                    role="button"
                    aria-label={`Close ${tab.label}`}
                    // Rides the same roving index as its tab, so the strip
                    // costs the Tab key two stops in total (selected tab, its
                    // close button) no matter how many tabs are open. Del on
                    // the focused tab does the same thing without leaving it.
                    tabIndex={roving ? 0 : -1}
                    onClick={(e) => { e.stopPropagation(); h.closeTab(tab.id); }}
                    onKeyDown={activateOnKey((ev) => closeTabFromKeyboard(tab, stripOf(ev)))}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--phn-danger, #e08784)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = ""; }}
                  >
                    ✕
                  </span>
                )}
              </div>
            );
          })}
          <div
            role="button"
            tabIndex={0}
            aria-label="New tab in this panel"
            onClick={(e) => { e.stopPropagation(); h.addTab(); }}
            onKeyDown={activateOnKey(() => h.addTab())}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 12px",
              cursor: "pointer",
              color: "var(--phn-text-faint, #586068)",
              fontSize: 15,
              lineHeight: 1,
              userSelect: "none",
              outlineOffset: -2, // see the tab's own note: the strip clips at 30px
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--phn-text-bright, #F2F4F7)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--phn-text-faint, #586068)"; }}
            title="New tab in this panel"
          >
            +
          </div>
        </div>
        {canClosePanel && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Close this panel"
            onClick={(e) => { e.stopPropagation(); h.closePanel(); }}
            onKeyDown={activateOnKey(() => h.closePanel())}
            style={{
              padding: "4px 8px",
              cursor: "pointer",
              color: "#555",
              fontSize: 11,
              userSelect: "none",
              outlineOffset: -2,
            }}
            title="Close this panel"
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--phn-danger, #e08784)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#555"; }}
          >
            ✕
          </div>
        )}
      </div>

      {/* Pane area: every tab stays mounted (only the active one is shown); each
          tab renders its split tree as flat positioned panes so splits/resizes
          never remount a live PTY. */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {panel.tabs.map(tab => {
          const tabVisible = tab.id === activeTab?.id;
          const layout = getLayout(tab);
          const { panes, dividers } = computeLayout(layout, dragRatios);
          const multi = panes.length > 1;
          const tabActivePaneId = tab.activePaneId || tab.id;
          // Zoom: when a pane in THIS tab is zoomed, it fills the tab (covering the
          // siblings, which stay MOUNTED so their PTYs live); dividers hide.
          const zoomNodeId = zoomedPaneId != null && panes.some((p) => p.node.id === zoomedPaneId) ? zoomedPaneId : null;
          return (
            <div
              key={tab.id}
              // Attributes only. The element type, the key and the position in
              // the tree are unchanged, so this cannot remount a pane
              // (invariant 1). display:none already removes the inactive ones
              // from the a11y tree, so no `hidden` attribute is needed.
              id={`phn-tabpanel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`phn-tab-${tab.id}`}
              style={{ position: "absolute", inset: 0, display: tabVisible ? "block" : "none" }}
            >
              {tab.home ? (
                <MobaHomeScreen panelId={panel.id} tabId={tab.id} api={homeApi} />
              ) : tab.vnc ? (
                <PaneBoundary label="VNC desktop"><VncView host={tab.vnc.host} port={tab.vnc.port} tabId={tab.id} visible={tabVisible} /></PaneBoundary>
              ) : tab.rdp ? (
                <PaneBoundary label="RDP desktop"><RdpView host={tab.rdp.host} port={tab.rdp.port} username={tab.rdp.username} domain={tab.rdp.domain} tabId={tab.id} visible={tabVisible} /></PaneBoundary>
              ) : tab.notebook ? (
                <PaneBoundary label="Notebook"><NotebookView name={tab.notebook.name} tabId={tab.id} visible={tabVisible} paneTitles={paneTitles} /></PaneBoundary>
              ) : (
              /* Dev drift-guard (release-audit): this arm must be reached ONLY
                 for plain terminal tabs. If isSpecialTab() (paneIds.js — the
                 registry sweep's exclusion predicate) says special but no
                 ternary arm above claimed the tab, the two files have drifted
                 and the sweep would mistreat this tab's panes. */
              <>
              {import.meta.env.DEV && isSpecialTab(tab)
                ? console.warn(`[panes] special tab ${tab.id} fell through to the TerminalPane arm. TerminalPanel's ternary is missing a type isSpecialTab() knows`)
                : null}
              {panes.map(({ node, rect }) => {
                const isRoot = node.id === tab.id;
                const paneActive = node.id === tabActivePaneId;
                const zoomed = zoomNodeId != null && node.id === zoomNodeId;
                const r = zoomed ? { left: 0, top: 0, width: 100, height: 100 } : rect;
                return (
                  <div
                    key={`pane-${node.id}`}
                    className="phn-pane"
                    data-pane-id={node.id}
                    data-pane-tab-id={tab.id}
                    onMouseDownCapture={() => { if (multi && !paneActive) onActivatePane?.(tab.id, node.id); }}
                    style={{
                      position: "absolute",
                      left: `${r.left}%`,
                      top: `${r.top}%`,
                      width: `${r.width}%`,
                      height: `${r.height}%`,
                      zIndex: zoomed ? 6 : undefined,
                      boxSizing: "border-box",
                      outline: multi && paneActive && !zoomNodeId ? `1px solid ${ACCENT}` : "none",
                      outlineOffset: "-1px",
                      overflow: "hidden",
                    }}
                  >
                    <TerminalPane
                      visible={tabVisible}
                      active={tabVisible && paneActive}
                      cwd={isRoot ? (tab.cwd || null) : (node.cwd ?? null)}
                      connection={isRoot ? (tab.connection || null) : null}
                      serial={isRoot ? (tab.serial || null) : null}
                      startCommands={isRoot ? (tab.startCommands || null) : null}
                      systemPrompt={isRoot ? (tab.systemPrompt || null) : null}
                      xtermTheme={xtermTheme}
                      promptEditor={promptEditor}
                      promptEditorVim={promptEditorVim}
                      tabId={node.id}
                      projectName={isRoot ? (tabProjectNames?.[tab.id] || null) : null}
                      autoApprove={isRoot ? (tabAutoApprove?.[tab.id] || false) : false}
                      onCostUpdate={costHandlerFor(node.id)}
                      saveUser={saveUser}
                    />
                    {/* Hover control cluster — split anywhere, zoom/close on
                        split tabs. Hidden until the pane is hovered (kept
                        visible while zoomed so un-zoom stays discoverable);
                        mousedown is stopped so a click here never re-activates
                        or types into the pane underneath. */}
                    <div className="phn-pane-controls" data-zoomed={zoomed ? "1" : undefined}>
                      <span
                        className="phn-pane-ctl"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); if (zoomed) setZoomedPaneId(null); onSplitPane?.(tab.id, node.id, "row"); }}
                        title="Split right (Ctrl+Shift+D)"
                      >
                        <SSplitRow size={12} />
                      </span>
                      <span
                        className="phn-pane-ctl"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); if (zoomed) setZoomedPaneId(null); onSplitPane?.(tab.id, node.id, "col"); }}
                        title="Split down (Ctrl+Shift+S)"
                      >
                        <SSplitCol size={12} />
                      </span>
                      {multi && (
                        <>
                          <span
                            className="phn-pane-ctl"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setZoomedPaneId(zoomed ? null : node.id); }}
                            title={zoomed ? "Restore split (un-zoom)" : "Zoom this pane to fill the tab"}
                          >
                            {zoomed ? "⤡" : "⤢"}
                          </span>
                          <span
                            className="phn-pane-ctl phn-pane-ctl-danger"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); onClosePane?.(tab.id, node.id); }}
                            title="Close this pane (Ctrl+Shift+X)"
                          >
                            ✕
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {!zoomNodeId && dividers.map((d) => {
                const isRow = d.dir === "row";
                const boundary = isRow
                  ? d.container.left + d.container.width * d.ratio
                  : d.container.top + d.container.height * d.ratio;
                return (
                  <div
                    key={`div-${d.splitId}`}
                    onMouseDown={(e) => handleDividerMouseDown(d, tab.id, e)}
                    onDoubleClick={(e) => { e.preventDefault(); onSetPaneRatio?.(tab.id, d.splitId, 0.5); }}
                    title="Drag to resize · double-click for 50/50"
                    style={{
                      position: "absolute",
                      zIndex: 4,
                      cursor: isRow ? "col-resize" : "row-resize",
                      ...(isRow
                        ? {
                            left: `calc(${boundary}% - 3px)`,
                            top: `${d.container.top}%`,
                            width: 6,
                            height: `${d.container.height}%`,
                          }
                        : {
                            top: `calc(${boundary}% - 3px)`,
                            left: `${d.container.left}%`,
                            height: 6,
                            width: `${d.container.width}%`,
                          }),
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(124,156,245,0.35)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  />
                );
              })}
              </>
              )}
            </div>
          );
        })}
      </div>

      {/* Tab context menu (right-click a tab). */}
      {tabCtxMenu && (() => {
        const tab = panel.tabs.find(t => t.id === tabCtxMenu.tabId);
        if (!tab) return null;
        // Dismiss, never a bare setTabCtxMenu(null): a native <button
        // role="menuitem"> turns Enter into click, and closing the menu while
        // focus is still inside it drops focus to <body>. dismissTabCtxMenu
        // hands focus back to the tab FIRST, so an action that moves focus
        // nowhere ("Close others", a share modal that opens after the button
        // is gone) still ends on a tab. The backdrop and the colour swatches go
        // through the same door for the same reason.
        //
        // focusTabIn also ARMS the reveal-focus guard (tabStripFocus.js), which
        // is right for a keystroke and wrong for the mouse: a user who
        // right-clicks and clicks "Duplicate" expects the caret in the new
        // shell, the way a click on a tab has always ended. A mouse click
        // carries detail > 0; Enter on a <button> synthesises a click with
        // detail 0. So the mouse releases the guard again, right after the
        // dismissal armed it.
        const multi = panel.tabs.length > 1;
        const item = (label, onClick, opts = {}) => (
          <button
            role="menuitem"
            // Nothing inside an open menu sits in the document tab sequence:
            // arrows move between items and Tab dismisses (onTabCtxMenuKey).
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); dismissTabCtxMenu(); if (e.detail > 0) releaseTabStripFocus(); if (!opts.disabled) onClick(); }}
            disabled={opts.disabled}
            style={{
              display: "block", width: "100%", textAlign: "left",
              background: "transparent", border: "none",
              color: opts.danger ? "var(--phn-danger, #f87171)" : TAB_FG_ACTIVE,
              padding: "6px 12px", fontFamily: M, fontSize: 12,
              cursor: opts.disabled ? "default" : "pointer", opacity: opts.disabled ? 0.4 : 1,
              whiteSpace: "nowrap", borderRadius: 4, boxSizing: "border-box",
            }}
            onMouseEnter={(e) => { if (!opts.disabled) e.currentTarget.style.background = "rgba(127,127,127,0.18)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            {label}
          </button>
        );
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onMouseDown={() => { dismissTabCtxMenu(); releaseTabStripFocus(); }} onContextMenu={(e) => { e.preventDefault(); dismissTabCtxMenu(); releaseTabStripFocus(); }} />
            <div
              ref={mountTabCtxMenu}
              // The marker attribute does double duty: the window-level Escape
              // effect scopes itself to the LAST one in document order, and
              // dismissTabCtxMenu reads the tab to hand focus back to off it.
              data-tab-ctx-menu={tabCtxMenu.tabId}
              // role="menu" is now honest: arrow-key navigation between
              // menuitem / menuitemradio children is implemented below, which
              // is the promise the role makes and the reason it was previously
              // declined here.
              role="menu"
              aria-label={`${tab.label || "Tab"} actions`}
              tabIndex={-1}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={onTabCtxMenuKey}
              style={{
                position: "fixed",
                left: Math.min(tabCtxMenu.x, window.innerWidth - 190),
                top: Math.min(tabCtxMenu.y, window.innerHeight - 180),
                width: 178,
                background: "var(--phn-surface-bg, #2d2d2d)",
                border: `1px solid ${BORDER_DIM}`,
                borderRadius: 6, padding: 5, zIndex: 9999,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              }}
            >
              {item("Rename", () => startRename(tab))}
              {onSetTabColor && (
                <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "6px 10px" }}>
                  {[null, "#ef4444", "#f59e0b", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7"].map((c) => (
                    <span
                      key={c || "none"}
                      // The row was click-only: it is eight of the menu's
                      // stops and a keyboard user could not reach any of them.
                      // menuitemradio, not menuitem, because exactly one of the
                      // eight is applied at a time — and aria-checked is also
                      // what menuRowsIn uses to pick the row's entry stop.
                      role="menuitemradio"
                      aria-checked={c === (tab.color || null)}
                      aria-label={c ? `Color this tab ${c}` : "Clear tab color"}
                      tabIndex={-1}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); dismissTabCtxMenu(); onSetTabColor(tab.id, c); }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        // A <span> gets no synthetic click from Enter the way a
                        // <button> would, so activation is explicit; Space
                        // would scroll without the preventDefault. Dismiss
                        // rather than close: recolouring moves focus nowhere,
                        // so without the hand-back this new keyboard route
                        // would end on <body>.
                        e.preventDefault();
                        e.stopPropagation();
                        dismissTabCtxMenu();
                        onSetTabColor(tab.id, c);
                      }}
                      title={c ? "Color this tab" : "Clear color"}
                      style={{
                        width: 14, height: 14, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                        background: c || "transparent",
                        // Ring pair + clear-glyph ink: see swatchRing() and
                        // SWATCH_CLEAR_GLYPH at the top of this file, where the
                        // fourteen-skin reasoning lives next to the values it
                        // constrains (and where the test can reach it).
                        border: swatchRing(c, tab.color),
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 9, color: SWATCH_CLEAR_GLYPH, lineHeight: 1,
                      }}
                    >
                      {c ? "" : "✕"}
                    </span>
                  ))}
                </div>
              )}
              {item("Duplicate", () => h.duplicate(tab.id))}
              {onDetachTab && !tab.home && item("Detach to new window", () => h.detach(tab.id))}
              {onSplitPane && item("Split right", () => onSplitPane(tab.id, tab.activePaneId || tab.id, "row"))}
              {!tab.home && !tab.vnc && !tab.rdp && !tab.notebook && item("Share transcript…", () => shareTranscript(tab))}
              <div style={{ height: 1, background: BORDER_DIM, margin: "4px 0" }} />
              {item("Close others", () => h.closeOthers(tab.id), { disabled: !multi })}
              {/* The keyboard close: dismiss has just put focus on the tab that is
                  about to be removed, so move it to a neighbour the way the
                  tab's own Delete key does. */}
              {item("Close", () => closeTabFromKeyboard(tab, stripFor(tabCtxMenuRef.current)), { disabled: !multi, danger: true })}
            </div>
          </>
        );
      })()}
      {shareTarget && (
        <ShareModal
          open
          kind={shareTarget.kind}
          title={shareTarget.title}
          rawText={shareTarget.rawText}
          dateStamp={shareTarget.dateStamp}
          onClose={() => setShareTarget(null)}
          saveUser={saveUser}
        />
      )}
    </div>
  );
}

// Memoized so a TerminalsTab re-render that doesn't change THIS panel's props
// (e.g. the 5s sysStats poll, a modal toggle, dock resize) skips re-rendering
// the panel + its xterm panes. All props are stable refs (panelId-bound
// callbacks via the `h` map; data props are useMemo/useState/primitives), so
// the default shallow compare correctly re-renders only on real panel changes.
export default memo(TerminalPanel);
