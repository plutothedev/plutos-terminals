// (C)
// Active-panel / active-tab derivation, lifted verbatim out of the TerminalsTab
// god component. These are plain per-render derivations — intentionally NOT
// memoized, exactly as the originals were: memoizing would change the reference
// identity of activeTab/activePanel and silently alter the dep-array behavior of
// the many downstream useCallbacks that close over activeTab/activeTabId.
// activeTabRecording reflects whether the focused tab is currently recording.
//
// Call this at the SAME position the inline consts used to sit: every reader of
// these four names lives below that point, so keeping the call there preserves
// declaration order (no temporal-dead-zone hazard).

export function useActiveTab(state, recordingTabIds) {
  const activePanel = state.panels.find((p) => p.id === state.activePanelId);
  const activeTabId = activePanel?.activeTabId;
  const activeTab = activePanel?.tabs.find((t) => t.id === activeTabId);
  const activeTabRecording = activeTabId ? recordingTabIds.includes(activeTabId) : false;
  return { activePanel, activeTabId, activeTab, activeTabRecording };
}
