// Settings modal. Edit Anthropic API key, app skin, terminal-bg override + factory reset.

import { useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";
import { useConfirm } from "./ConfirmModal.jsx";
import { getSkinId } from "../features/terminals/headerSkins.js";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#FF0080";

export default function SettingsModal({ open, st, save, onClose }) {
  // API keys + models now live entirely in the Models section (the single place
  // for anything LLM/key-related). Settings is appearance + factory reset.
  const [headerSkin, setHeaderSkin] = useState(getSkinId(st.headerSkin));
  const toast = useToast();
  const confirm = useConfirm();

  const handleSave = () => {
    save({ ...st, headerSkin: getSkinId(headerSkin) });
    toast.success("Settings saved.");
    onClose();
  };

  // Live theme preview — applies as soon as you pick (no save needed).
  const setTheme = (id) => {
    const next = getSkinId(id);
    setHeaderSkin(next);
    save({ ...st, headerSkin: next });
  };
  const isLight = headerSkin === "moba-light";

  const handleFactoryReset = async () => {
    const ok = await confirm(
      "Factory reset wipes ALL Pluto's Terminal state from this machine: panel layout, projects, scrollback, API key, theme, welcome flag, and onboarding flag (across every window). The app reloads to the welcome screen. Continue?",
      { title: "Factory reset?", confirmLabel: "reset everything", destructive: true }
    );
    if (!ok) return;
    try {
      // v0.1.21: also wipe shared user state + any per-window state from
      // multi-window setups. Walks all keys to catch suffixed window states.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k === "plutos-terminals:user:v0" || k.startsWith("plutos-terminals:state:v0"))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) { /* ignore */ }
    window.location.reload();
  };

  return (
    <Modal open={open} title="Settings" onClose={onClose} width={560}>
      <Field label="AI MODELS & API KEYS">
        <Hint>
          All provider API keys (Anthropic, OpenAI, and the rest) and model selection now live in the
          <strong> Models</strong> section — open it from the toolbar's <strong>Models</strong> button or the command palette (Ctrl+K → “Models”).
        </Hint>
      </Field>

      <Field label="APPEARANCE (LIVE PREVIEW)">
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setTheme("moba")} style={isLight ? toggleBtnStyle : toggleBtnActiveStyle}>
            🌙  Dark
          </button>
          <button onClick={() => setTheme("moba-light")} style={isLight ? toggleBtnActiveStyle : toggleBtnStyle}>
            ☀️  Light
          </button>
        </div>
        <Hint>Switches the whole app chrome between dark and light. The terminal itself stays black either way.</Hint>
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

const toggleBtnStyle = {
  flex: 1,
  background: "var(--phn-page-bg, #0a0a0a)",
  border: `1px solid ${BORDER}`,
  color: FG,
  padding: "9px 12px",
  borderRadius: 4,
  fontFamily: M,
  fontSize: 12,
  cursor: "pointer",
};

const toggleBtnActiveStyle = {
  ...toggleBtnStyle,
  background: "var(--phn-accent-subtle, rgba(74,168,192,0.16))",
  border: `1px solid ${ACCENT}`,
  color: FG_ACTIVE,
  fontWeight: 600,
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

