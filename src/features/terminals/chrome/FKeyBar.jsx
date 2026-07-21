// (C)
import { GITHUB_URL, openExternal } from "../../../appMeta.js";

export default function FKeyBar({
  addTab,
  activePanelId,
  activeTabId,
  activeTab,
  splitPane,
  selectRibbon,
  setCommandPaletteOpen,
  setAskOpen,
  setHistoryOpen,
  setModelsOpen,
  setMacrosOpen,
}) {
  return (
    <div className="phn-fnbar">
      {[
        { k: "F1", l: "Help", fn: () => openExternal(GITHUB_URL) },
        { k: "F2", l: "Tab", fn: () => addTab(activePanelId) },
        { k: "F3", l: "Split", fn: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
        { k: "F4", l: "SFTP", fn: () => selectRibbon("files") },
        { k: "⌘K", l: "Palette", fn: () => setCommandPaletteOpen(true) },
        { k: "⌘I", l: "Ask AI", fn: () => setAskOpen(true) },
        { k: "⌘R", l: "History", fn: () => setHistoryOpen(true) },
        { k: "⌘M", l: "Models", fn: () => setModelsOpen(true) },
        { k: "F9", l: "Macro", fn: () => setMacrosOpen(true) },
      ].map((b) => (
        <button key={b.k} className="phn-fn" onClick={b.fn} title={`${b.k} — ${b.l}`}>
          <b>{b.k}</b> {b.l}
        </button>
      ))}
    </div>
  );
}
