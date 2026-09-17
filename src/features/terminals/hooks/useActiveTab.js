// (C)
// Active-panel / active-tab derivation, lifted verbatim out of the TerminalsTab
// god component. These are plain per-render derivations — intentionally NOT
// memoized, exactly as the originals were: memoizing would change the reference
// identity of activeTab/activePanel and silently alter the dep-array behavior of
// the many downstream useCallbacks that close over activeTab/activeTabId.
//
// TAB-level identity only. This hook deliberately does NOT derive "is the
// focused terminal recording": recordings are keyed by PANE id (audit FE-1,
// TerminalPane pushes output under its LEAF id), and `activeTabId` is a tab id,
// so the tab-keyed form that used to live here returned the wrong answer on
// every split tab. That derivation now sits in TerminalsTab beside
// `resolveActivePaneId(activeTab)`, the one place that knows the pane. Do not
// reintroduce a copy here: leaving the pre-fix expression next to the fix is
// exactly how the tab-vs-pane drift happened the first time.
//
// Call this at the SAME position the inline consts used to sit: every reader of
// these three names lives below that point, so keeping the call there preserves
// declaration order (no temporal-dead-zone hazard).

export function useActiveTab(state) {
  const activePanel = state.panels.find((p) => p.id === state.activePanelId);
  const activeTabId = activePanel?.activeTabId;
  const activeTab = activePanel?.tabs.find((t) => t.id === activeTabId);
  return { activePanel, activeTabId, activeTab };
}
