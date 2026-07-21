// Settings modal. App appearance (dark/light chrome) + factory reset.
// API keys + model selection live in the Models section, not here.

import { useState } from "react";
import Modal from "./Modal.jsx";
import { useToast } from "./Toast.jsx";
import { useConfirm } from "./ConfirmModal.jsx";
import { Button, Field } from "./ui.jsx";
import { getSkinId } from "../features/terminals/headerSkins.js";
import { wipeAllLocalState } from "../features/terminals/storageKeys.js";
import KeybindingsSection from "../features/terminals/KeybindingsSection.jsx";
import ThemesSection from "../features/terminals/ThemesSection.jsx";
import SyncSection from "../features/terminals/SyncSection.jsx";
import AgentSection from "../features/terminals/AgentSection.jsx";
import { SMoon, SSun } from "../features/terminals/toolbarIcons.jsx";

export default function SettingsModal({ open, st, save, userSt, saveUser, onClose }) {
  const [headerSkin, setHeaderSkin] = useState(getSkinId(st.headerSkin));
  const toast = useToast();
  const confirm = useConfirm();

  const handleSave = () => {
    // Preserve an active custom theme (custom:<id>) — the Dark/Light picker only
    // governs the built-in chrome skin and already persists live.
    const cur = st.headerSkin;
    const nextSkin = typeof cur === "string" && cur.startsWith("custom:") ? cur : getSkinId(headerSkin);
    save({ ...st, headerSkin: nextSkin });
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
  const isOled = headerSkin === "oled";

  const handleFactoryReset = async () => {
    const ok = await confirm(
      "Factory reset wipes ALL Pluto's Terminal state from this machine: panel layout, projects, scrollback, API key, theme, welcome flag, and onboarding flag (across every window). The app reloads to the welcome screen. Continue?",
      { title: "Factory reset?", confirmLabel: "reset everything", destructive: true }
    );
    if (!ok) return;
    // Wipe EVERY app-owned key (state/user blobs, per-window states, command
    // history, macros, dock layout, dismissed-update) — see ALL_STORAGE_PREFIXES
    // in storageKeys.js. The old inline loop missed cmdhistory/macros/pt:* keys.
    wipeAllLocalState();
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
        hint="Dark and Light switch the app chrome (terminal stays black). OLED turns every surface — chrome and terminal — true #000 for OLED panels."
      >
        <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
          <Button variant={!isLight && !isOled ? "primary" : "ghost"} onClick={() => setTheme("moba")} style={{ flex: 1 }}><span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}><SMoon size={13} /> Dark</span></Button>
          <Button variant={isLight ? "primary" : "ghost"} onClick={() => setTheme("moba-light")} style={{ flex: 1 }}><span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}><SSun size={13} /> Light</span></Button>
          <Button variant={isOled ? "primary" : "ghost"} onClick={() => setTheme("oled")} style={{ flex: 1 }}><span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}><SMoon size={13} /> OLED</span></Button>
        </div>
      </Field>

      <Field
        label="Prompt editor (beta)"
        hint="App-owned input line at the shell prompt: syntax highlighting, ↑/↓ history, Enter to run. Full-screen apps (vim, ssh prompts, REPLs) pass through untouched. Off = the classic terminal."
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={!!st.promptEditor} onChange={(e) => save({ ...st, promptEditor: e.target.checked })} />
          Enable the app-owned prompt editor
        </label>
        {st.promptEditor && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", marginTop: 6, marginLeft: 22 }}>
            <input type="checkbox" checked={!!st.promptEditorVim} onChange={(e) => save({ ...st, promptEditorVim: e.target.checked })} />
            Vim keybindings (Esc → normal mode)
          </label>
        )}
      </Field>

      {saveUser && (
        <Field
          label="Custom themes"
          hint="Import a Warp theme and use it across the terminal and the whole app."
        >
          <ThemesSection st={st} save={save} userSt={userSt} saveUser={saveUser} />
        </Field>
      )}

      {saveUser && (
        <Field
          label="Keyboard shortcuts"
          hint="Click a shortcut, then press the new key combo (Esc cancels). Changes apply instantly and sync across windows."
        >
          <KeybindingsSection userSt={userSt} saveUser={saveUser} />
        </Field>
      )}

      {saveUser && (
        <Field
          label="Cloud Sync"
          hint="End-to-end encrypted. Syncs workflows, themes, keybindings, settings, and macros across your machines via a private git repo you control. API keys never sync."
        >
          <SyncSection userSt={userSt} saveUser={saveUser} />
        </Field>
      )}

      {saveUser && (
        <Field label="Agent" hint="Project context + global rules for Agent Mode">
          <AgentSection userSt={userSt} saveUser={saveUser} />
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
