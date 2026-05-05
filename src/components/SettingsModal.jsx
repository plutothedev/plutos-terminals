// Settings modal. Edit Anthropic API key, VAULT path, Discord invite URL,
// default theme, custom env overrides. Plus factory reset (clears all
// localStorage state).

import { useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#FF0080";
const DEFAULT_DISCORD = "https://discord.gg/3cZQVgKF";

export default function SettingsModal({ open, st, save, onClose }) {
  const [anthropicKey, setAnthropicKey] = useState(st.anthropicKey || "");
  const [vaultPath, setVaultPath] = useState(st.vaultPath || "");
  const [discordUrl, setDiscordUrl] = useState(st.discordUrl || DEFAULT_DISCORD);
  const [showKey, setShowKey] = useState(false);

  const handleSave = () => {
    save({
      ...st,
      anthropicKey,
      vaultPath,
      discordUrl: discordUrl || DEFAULT_DISCORD,
    });
    onClose();
  };

  const handleClearKey = () => {
    if (window.confirm("Clear your Anthropic API key from local storage? Spawned shells won't auto-receive it after this.")) {
      setAnthropicKey("");
      save({ ...st, anthropicKey: "" });
    }
  };

  const handleFactoryReset = () => {
    const confirmed = window.confirm(
      "Factory reset wipes ALL Pluto's Terminals state from this machine: panel layout, projects, scrollback, API key, vault path, theme, and welcome flag. The app reloads to the welcome screen. Continue?"
    );
    if (!confirmed) return;
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

      <Field label="${VAULT} PATH">
        <input
          type="text"
          value={vaultPath}
          onChange={(e) => setVaultPath(e.target.value)}
          placeholder="C:\Users\you\Documents\my-second-brain"
          style={inputStyle}
        />
        <Hint>Used by packs that reference ${"${VAULT}"} in their cwd (e.g. <code style={codeStyle}>pluto-personal-strategist</code>). Leave blank if you don't have a second-brain vault.</Hint>
      </Field>

      <Field label="PLUTO DISCORD INVITE URL">
        <input
          type="text"
          value={discordUrl}
          onChange={(e) => setDiscordUrl(e.target.value)}
          placeholder={DEFAULT_DISCORD}
          style={inputStyle}
        />
        <Hint>Default: <code style={codeStyle}>{DEFAULT_DISCORD}</code>. Welcome screen "JOIN PLUTO DISCORD" button opens this URL.</Hint>
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
  background: "#0a0a0a",
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

const codeStyle = {
  background: "#0a0a0a",
  padding: "1px 4px",
  borderRadius: 2,
  fontSize: 10,
};
