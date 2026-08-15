// (C)
import { memo } from "react";
import { GITHUB_URL, openExternal } from "../../../appMeta.js";
import { modCombo } from "../keybindings.js";

function FKeyBar({
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
    <div className="phn-fnbar" data-tour="fkey-bar">
      {[
        { k: "F1", l: "Help", t: "open help on GitHub", fn: () => openExternal(GITHUB_URL) },
        { k: "F2", l: "New Tab", fn: () => addTab(activePanelId) },
        { k: "F3", l: "Split", fn: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
        { k: "F4", l: "SFTP", fn: () => selectRibbon("files") },
        // Shortcut chips follow the platform: "Ctrl+K" on Windows/Linux,
        // "⌘K" on macOS (the glyphs were hardcoded ⌘ before — wrong ON a PC).
        { k: modCombo("K"), l: "Palette", fn: () => setCommandPaletteOpen(true), tour: "fkey-palette" },
        { k: modCombo("I"), l: "Ask AI", fn: () => setAskOpen(true) },
        { k: modCombo("R"), l: "History", fn: () => setHistoryOpen(true) },
        { k: modCombo("M"), l: "Models", fn: () => setModelsOpen(true) },
        { k: "F9", l: "Macros", fn: () => setMacrosOpen(true) },
      ].map((b) => (
        <button key={b.k} className="phn-fn" data-tour={b.tour} onClick={b.fn} title={`${b.k} — ${b.t || b.l}`}>
          <b>{b.k}</b> {b.l}
        </button>
      ))}
    </div>
  );
}

export default memo(FKeyBar);
