// (C)
// Which PANE a chrome-level "act on the active terminal" action must address.
//
// The PTY-facing registries are all keyed by PANE id, not TAB id: TerminalPanel
// renders each leaf of a tab's split tree as `<TerminalPane tabId={node.id}>`,
// and that pane registers itself under that id with ptyBridge
// (registerPtyWriter / registerTabReader / setPtyId), the asciinema recorder
// (pushOutput) and the macro capture (recordInput). The chrome, meanwhile, only
// knows `panel.activeTabId`. The two ids coincide in exactly one case: an
// unsplit tab that still owns its original pane.
//
// Two structural reasons they diverge (audit FE-1):
//   1. splitLeaf() keeps the existing leaf's id and adds the NEW leaf beside it,
//      so on a split tab `tab.id` is permanently the FIRST leaf, while
//      useWorkspaceTree moves focus to the new leaf. An action keyed on tab.id
//      lands in the pane the user just split away from.
//   2. removeLeaf() collapses a two-leaf tree to its surviving sibling, so
//      closing the ORIGINAL pane leaves a tab where NO leaf id equals tab.id.
//      Every tab.id lookup is then `undefined` for the life of that tab.
//
// Hence: validate the stored activePaneId against the tab's LIVE leaf set and
// fall back to the first leaf. Never fall back to tab.id: that is precisely the
// id that case 2 makes dead.
import { getLayout, leafIds } from "./splitTree.js";

export function resolveActivePaneId(tab) {
  if (!tab || tab.id == null) return null;
  const leaves = leafIds(getLayout(tab));
  // getLayout always yields at least an implicit root leaf, so this is
  // defensive only (a hand-edited / corrupt layout blob with a null branch).
  if (leaves.length === 0) return tab.id;
  const stored = tab.activePaneId;
  if (stored != null && leaves.includes(stored)) return stored;
  return leaves[0];
}

// Every pane id the given panels currently render, as a Set. Used as the live
// set for pruning pane-keyed side registries (the recorder) on the same
// commit-time sweep that reconciles the pane registry. Special tabs
// (home/vnc/rdp/notebook) mount no TerminalPane, so their ids are included via
// resolveActivePaneId's own fallback. They can hold a recording that records
// nothing, and pruning it out from under a "● rec" indicator mid-session would
// be a worse lie than letting it sit until the tab closes.
export function allPaneTargets(panels) {
  const ids = new Set();
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      for (const id of leafIds(getLayout(tab))) ids.add(id);
    }
  }
  return ids;
}

// The panel + tab that owns a given pane id, or null. The status bar hands back
// a recording's key (a PANE id) and the app has to focus the terminal it
// belongs to, which on a split tab is not a tab whose id matches.
export function findPaneOwner(panels, paneId) {
  if (paneId == null) return null;
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      if (leafIds(getLayout(tab)).includes(paneId)) return { panel, tab };
    }
  }
  return null;
}
