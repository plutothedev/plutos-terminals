// Settings modal. Edit Anthropic API key, app skin, terminal-bg override + factory reset.

import { useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";
import { useConfirm } from "./ConfirmModal.jsx";
import {
  HEADER_SKINS,
  HEADER_BUTTON_STYLES,
  getSkinId,
  getButtonStyleId,
} from "../features/terminals/headerSkins.js";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#FF0080";

export default function SettingsModal({ open, st, save, onClose }) {
  const [anthropicKey, setAnthropicKey] = useState(st.anthropicKey || "");
  const [headerSkin, setHeaderSkin] = useState(getSkinId(st.headerSkin));
  const [headerButtonStyle, setHeaderButtonStyle] = useState(getButtonStyleId(st.headerButtonStyle));
  const [pureBlackTerminal, setPureBlackTerminal] = useState(!!st.pureBlackTerminal);
  const [showKey, setShowKey] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const handleSave = () => {
    if (anthropicKey && !anthropicKey.startsWith("sk-ant-") && !anthropicKey.startsWith("sk-")) {
      toast.error("API key doesn't look right — should start with 'sk-ant-'. Double-check.");
      return;
    }
    save({
      ...st,
      anthropicKey,
      headerSkin: getSkinId(headerSkin),
      headerButtonStyle: getButtonStyleId(headerButtonStyle),
      pureBlackTerminal,
    });
    toast.success("Settings saved.");
    onClose();
  };

  // Live skin preview — applies as soon as user picks (no need to save first).
  const handleSkinChange = (id) => {
    const next = getSkinId(id);
    setHeaderSkin(next);
    save({ ...st, headerSkin: next });
  };

  const handlePureBlackToggle = (next) => {
    setPureBlackTerminal(next);
    save({ ...st, pureBlackTerminal: next });
  };

  // Live button-style preview — applies as soon as user picks.
  const handleButtonStyleChange = (id) => {
    const next = getButtonStyleId(id);
    setHeaderButtonStyle(next);
    save({ ...st, headerButtonStyle: next });
  };

  const activeSkinDescription =
    HEADER_SKINS.find((s) => s.id === headerSkin)?.description || "";

  const activeButtonStyleDescription =
    HEADER_BUTTON_STYLES.find((s) => s.id === headerButtonStyle)?.description || "";

  const handleClearKey = async () => {
    const ok = await confirm(
      "Clear your Anthropic API key from local storage? Spawned shells won't auto-receive it after this.",
      { title: "Clear API key?", confirmLabel: "clear", destructive: true }
    );
    if (!ok) return;
    setAnthropicKey("");
    save({ ...st, anthropicKey: "" });
    toast.info("API key cleared.");
  };

  const handleFactoryReset = async () => {
    const ok = await confirm(
      "Factory reset wipes ALL Pluto's Terminals state from this machine: panel layout, projects, scrollback, API key, theme, and welcome flag. The app reloads to the welcome screen. Continue?",
      { title: "Factory reset?", confirmLabel: "reset everything", destructive: true }
    );
    if (!ok) return;
    try {
      localStorage.removeItem("plutos-terminals:state:v0");
    } catch (_) { /* ignore */ }
    window.location.reload();
  };

  return (
    <Modal open={open} title="Settings" onClose={onClose} width={560}>
      <Field label="ANTHROPIC API KEY">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type={showKey ? "text" : "password"}
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            placeholder="sk-ant-..."
            style={inputStyle}
          />
          <button onClick={() => setShowKey(s => !s)} style={chipBtnStyle} title={showKey ? "Hide" : "Show"}>
            {showKey ? "hide" : "show"}
          </button>
          <button onClick={handleClearKey} style={chipBtnStyle} title="Clear key from storage">
            clear
          </button>
        </div>
        <Hint>Auto-injected as ANTHROPIC_API_KEY into every new shell. Stored in plain JSON in app local data dir.</Hint>
      </Field>

      <Field label="APP SKIN (LIVE PREVIEW)">
        <select
          value={headerSkin}
          onChange={(e) => handleSkinChange(e.target.value)}
          style={inputStyle}
        >
          {HEADER_SKINS.map((s) => (
            <option key={s.id} value={s.id} style={{ background: "var(--phn-page-bg, #0a0a0a)", color: FG_ACTIVE }}>
              {s.label}
            </option>
          ))}
        </select>
        <Hint>{activeSkinDescription} The skin themes the entire app — header, sidebar, status bar, and terminal background. Changes apply instantly.</Hint>
      </Field>

      <Field label="HEADER BUTTONS (LIVE PREVIEW)">
        <select
          value={headerButtonStyle}
          onChange={(e) => handleButtonStyleChange(e.target.value)}
          style={inputStyle}
        >
          {HEADER_BUTTON_STYLES.map((s) => (
            <option key={s.id} value={s.id} style={{ background: "var(--phn-page-bg, #0a0a0a)", color: FG_ACTIVE }}>
              {s.label}
            </option>
          ))}
        </select>
        <Hint>{activeButtonStyleDescription} Combines with any skin — same colors, different button shape / border / hover. Pick what feels right for your skin.</Hint>
      </Field>

      <Field label="TERMINAL BACKGROUND">
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={pureBlackTerminal}
            onChange={(e) => handlePureBlackToggle(e.target.checked)}
            style={{ accentColor: ACCENT, cursor: "pointer" }}
          />
          <span style={{ color: FG_ACTIVE, fontSize: 11 }}>Use pure black terminal background</span>
        </label>
        <Hint>By default the terminal background matches the app skin (e.g. amber, daylight, sunset). Check this to force a classic black terminal regardless of skin.</Hint>
      </Field>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
        <button onClick={handleFactoryReset} style={dangerBtnStyle} title="Wipe all local state and reload">
          factory reset
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={chipBtnStyle}>cancel</button>
          <button onClick={handleSave} style={primaryBtnStyle}>save</button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ color: FG_DIM, fontSize: 11, letterSpacing: 0.5, display: "block", marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Hint({ children }) {
  return <div style={{ color: FG_DIM, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>{children}</div>;
}

const inputStyle = {
  width: "100%",
  background: "var(--phn-page-bg, #0a0a0a)",
  border: `1px solid ${BORDER}`,
  color: FG_ACTIVE,
  padding: "8px 10px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  outline: "none",
  boxSizing: "border-box",
};

const chipBtnStyle = {
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: FG,
  padding: "6px 12px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryBtnStyle = {
  background: ACCENT,
  border: `1px solid ${ACCENT}`,
  color: "#001",
  padding: "6px 18px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

const dangerBtnStyle = {
  background: "transparent",
  border: `1px solid ${PLUTO_MAGENTA}`,
  color: PLUTO_MAGENTA,
  padding: "6px 12px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  cursor: "pointer",
};

