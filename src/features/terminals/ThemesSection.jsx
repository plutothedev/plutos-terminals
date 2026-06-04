// (C)
// Settings → Custom themes. Import a Warp theme YAML (paste, or load the
// example), apply it (drives both the terminal palette and the app chrome),
// export any theme back to Warp YAML, or delete it. Themes persist in
// userSt.customThemes (shared across windows); the active selection is
// st.headerSkin === "custom:<id>".

import { useState } from "react";
import { Button, Textarea, Field } from "../../components/ui.jsx";
import { useToast } from "../../components/Toast.jsx";
import { useConfirm } from "../../components/ConfirmModal.jsx";
import { CUSTOM_PREFIX } from "./headerSkins.js";
import { warpYamlToThemes, themeToWarpYaml, EXAMPLE_WARP_YAML } from "./customThemes.js";

function Swatch({ theme }) {
  const xt = theme.xterm || {};
  const dots = [xt.background, xt.foreground, theme.source?.accent || xt.cursor, xt.red, xt.green, xt.yellow, xt.blue, xt.magenta, xt.cyan];
  return (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
      {dots.map((c, i) => (
        <span key={i} style={{ width: 11, height: 11, borderRadius: 2, background: c || "#000", border: "1px solid rgba(128,128,128,0.4)" }} />
      ))}
    </span>
  );
}

export default function ThemesSection({ st, save, userSt, saveUser }) {
  const [text, setText] = useState("");
  const toast = useToast();
  const confirm = useConfirm();

  const themes = Array.isArray(userSt?.customThemes) ? userSt.customThemes : [];
  const active = st?.headerSkin;

  const doImport = () => {
    const src = text.trim();
    if (!src) { toast.error("Paste a Warp theme YAML first."); return; }
    let parsed;
    try {
      parsed = warpYamlToThemes(src);
    } catch (err) {
      toast.error(`Import failed: ${err.message || err}`);
      return;
    }
    saveUser({ ...userSt, customThemes: [...themes, ...parsed] });
    setText("");
    // Apply the first imported theme immediately so the effect is visible.
    save({ ...st, headerSkin: CUSTOM_PREFIX + parsed[0].id });
    toast.success(parsed.length === 1 ? `Imported & applied “${parsed[0].name}”.` : `Imported ${parsed.length} themes.`);
  };

  const applyTheme = (id) => save({ ...st, headerSkin: CUSTOM_PREFIX + id });

  const exportTheme = async (theme) => {
    try {
      await navigator.clipboard.writeText(themeToWarpYaml(theme));
      toast.success(`Copied “${theme.name}” YAML to clipboard.`);
    } catch (err) {
      toast.error(`Copy failed: ${err}`);
    }
  };

  const deleteTheme = async (theme) => {
    const ok = await confirm(`Delete the custom theme “${theme.name}”?`, {
      title: "Delete theme?", confirmLabel: "delete", destructive: true,
    });
    if (!ok) return;
    saveUser({ ...userSt, customThemes: themes.filter((t) => t.id !== theme.id) });
    if (active === CUSTOM_PREFIX + theme.id) {
      save({ ...st, headerSkin: theme.dark === false ? "moba-light" : "moba" });
    }
    toast.success(`Deleted “${theme.name}”.`);
  };

  return (
    <div>
      {themes.length > 0 && (
        <div style={{ marginBottom: "var(--phn-sp-3)" }}>
          {themes.map((theme) => {
            const isActive = active === CUSTOM_PREFIX + theme.id;
            return (
              <div key={theme.id} style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "6px 0", borderBottom: "1px solid var(--phn-surface-border, #222)" }}>
                <Swatch theme={theme} />
                <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {theme.name}
                  <span style={{ opacity: 0.5, fontSize: 11 }}>&nbsp;· {theme.dark === false ? "light" : "dark"}</span>
                </span>
                {isActive
                  ? <span className="phn-ui-kbd" style={{ color: "var(--phn-link)" }}>active</span>
                  : <Button size="sm" variant="primary" onClick={() => applyTheme(theme.id)}>apply</Button>}
                <Button size="sm" variant="subtle" onClick={() => exportTheme(theme)} title="Copy as Warp YAML">export</Button>
                <Button size="sm" variant="subtle" onClick={() => deleteTheme(theme)} title="Delete this theme">✕</Button>
              </div>
            );
          })}
        </div>
      )}

      <Field
        label="Import a Warp theme (YAML)"
        hint={<>Paste a theme from <strong>github.com/warpdotdev/themes</strong> (or any Warp-format YAML). It drives the terminal colors and the app chrome. Switch back anytime with the Dark/Light buttons above.</>}
      >
        <Textarea
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"name: My Theme\nbackground: \"#1e1e2e\"\nforeground: \"#cdd6f4\"\naccent: \"#89b4fa\"\nterminal_colors:\n  normal: { ... }\n  bright: { ... }"}
        />
        <div style={{ display: "flex", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-2)" }}>
          <Button variant="primary" onClick={doImport}>import &amp; apply</Button>
          <Button variant="subtle" onClick={() => setText(EXAMPLE_WARP_YAML)}>load example (Dracula)</Button>
        </div>
      </Field>
    </div>
  );
}
