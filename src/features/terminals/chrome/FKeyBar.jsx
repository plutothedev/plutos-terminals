// (C)
import { GITHUB_URL, openExternal } from "../../../appMeta.js";
import { modCombo } from "../keybindings.js";

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
        // Shortcut chips follow the platform: "Ctrl+K" on Windows/Linux,
        // "⌘K" on macOS (the glyphs were hardcoded ⌘ before — wrong ON a PC).
        { k: modCombo("K"), l: "Palette", fn: () => setCommandPaletteOpen(true) },
        { k: modCombo("I"), l: "Ask AI", fn: () => setAskOpen(true) },
        { k: modCombo("R"), l: "History", fn: () => setHistoryOpen(true) },
        { k: modCombo("M"), l: "Models", fn: () => setModelsOpen(true) },
        { k: "F9", l: "Macro", fn: () => setMacrosOpen(true) },
      ].map((b) => (
        <button key={b.k} className="phn-fn" onClick={b.fn} title={`${b.k} — ${b.l}`}>
          <b>{b.k}</b> {b.l}
        </button>
      ))}
    </div>
  );
}
