// Settings modal. App appearance (dark/light chrome) + factory reset.
// API keys + model selection live in the Models section, not here.

import { useState } from "react";
import Modal from "./Modal.jsx";
import { useToast } from "./Toast.jsx";
import { useConfirm } from "./ConfirmModal.jsx";
import { Button, Field } from "./ui.jsx";
import { getSkinId } from "../features/terminals/headerSkins.js";
import { USER_STORAGE_KEY, STATE_KEY_PREFIX } from "../features/terminals/storageKeys.js";
import KeybindingsSection from "../features/terminals/KeybindingsSection.jsx";

export default function SettingsModal({ open, st, save, userSt, saveUser, onClose }) {
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
        if (k && (k === USER_STORAGE_KEY || k.startsWith(STATE_KEY_PREFIX))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) { /* ignore */ }
    window.location.reload();
  };

  return (
    <Modal open={open} title="Settings" onClose={onClose} width={560}>
      <Field
        label="AI models & API keys"
        hint={
          <>
            All provider API keys (Anthropic, OpenAI, and the rest) and model selection now live in the{" "}
            <strong>Models</strong> section — open it from the toolbar's <strong>Models</strong> button or the command palette (Ctrl+K → “Models”).
          </>
        }
      />

      <Field
        label="Appearance (live preview)"
        hint="Switches the whole app chrome between dark and light. The terminal itself stays black either way."
      >
        <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
          <Button variant={isLight ? "ghost" : "primary"} onClick={() => setTheme("moba")} style={{ flex: 1 }}>🌙&nbsp; Dark</Button>
          <Button variant={isLight ? "primary" : "ghost"} onClick={() => setTheme("moba-light")} style={{ flex: 1 }}>☀️&nbsp; Light</Button>
        </div>
      </Field>

      {saveUser && (
        <Field
          label="Keyboard shortcuts"
          hint="Click a shortcut, then press the new key combo (Esc cancels). Changes apply instantly and sync across windows."
        >
          <KeybindingsSection userSt={userSt} saveUser={saveUser} />
        </Field>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--phn-sp-6)" }}>
        <Button variant="danger" onClick={handleFactoryReset} title="Wipe all local state and reload">factory reset</Button>
        <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
          <Button variant="subtle" onClick={onClose}>cancel</Button>
          <Button variant="primary" onClick={handleSave}>save</Button>
        </div>
      </div>
    </Modal>
  );
}
