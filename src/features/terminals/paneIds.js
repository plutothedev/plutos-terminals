// (C)
// Shared leaf-id derivation (B1 plan, decision 3 + Task 2 Step 1). The id
// TerminalPane receives as `tabId` is the LEAF id TerminalPanel derives when
// rendering a tab's split tree — this module mirrors that derivation
// byte-for-byte so the registry sweep (TerminalsTab.jsx) enumerates exactly
// what TerminalPanel renders. Any drift here would make the sweep destroy
// live panes (a false-negative "not live") or leak dead ones (a false-
// positive "still live").
//
// Verified against TerminalPanel.jsx (~:487-547): for EVERY tab in a panel —
// including a non-active (hidden) one; only the wrapping div's CSS `display`
// toggles, the tab (and its TerminalPane(s)) stay mounted — TerminalPanel
// computes `getLayout(tab)` and walks it into flat panes via computeLayout,
// whose recursion shape (isLeaf base case -> one entry; else concat the `a`
// subtree then the `b` subtree) is identical to splitTree.js's own `leafIds`.
// So `computeLayout(getLayout(tab), ...).panes.map(p => p.node.id)` ===
// `leafIds(getLayout(tab))`.
//
// The one exception: a tab with `home`/`vnc`/`rdp`/`notebook` set renders
// MobaHomeScreen/VncView/RdpView/NotebookView instead of any TerminalPane
// (TerminalPanel's per-tab ternary), so it creates no registry entries — it
// must be excluded here too, or the sweep would treat a stale id from a former
// TerminalPane as still "live" forever.
import { getLayout, leafIds } from "./splitTree.js";

// THE single source of truth for "this tab renders a special view, not
// TerminalPanes" (release-audit hardening). TerminalPanel's render ternary
// must dispatch on exactly these flags; its panes arm dev-warns through this
// predicate, so adding a type here without a ternary arm fails loudly in dev
// instead of silently letting the registry sweep treat the tab wrong.
export function isSpecialTab(tab) {
  return !!(tab && (tab.home || tab.vnc || tab.rdp || tab.notebook));
}

// Pane ids grouped by owning TAB, in render order (P4-T5 trickle). tabId
// keying is what stops a 3-split tab from consuming 3 trickle slots — the
// whole tab's panes release together. Same special-tab exclusion as
// allRenderedPaneIds (no TerminalPane mounts → nothing to spawn).
export function tabPaneIdGroups(panels) {
  const groups = [];
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      if (isSpecialTab(tab)) continue;
      groups.push({ tabId: tab.id, paneIds: leafIds(getLayout(tab)) });
    }
  }
  return groups;
}

export function allRenderedPaneIds(panels) {
  const ids = [];
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      if (isSpecialTab(tab)) continue; // no TerminalPane mounts; no registry entries
      ids.push(...leafIds(getLayout(tab)));
    }
  }
  return ids;
}
