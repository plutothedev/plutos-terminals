// (C)
// Settings → Keybindings: remap the global shortcuts. Click a row's combo to
// record a new one; conflicts with another action are rejected. Reset returns a
// row to its default; Disable unbinds it. Overrides persist in
// userSt.keybindings via saveUser (shared across windows).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@backend";
import { Button } from "../../components/ui.jsx";
import {
  KEY_ACTIONS, CATEGORY_ORDER, resolveBindings, comboFromEvent, canon,
  isBindable, formatCombo, setCapturing,
  DEFAULT_SUMMON, comboFromCode, isSummonBindable, formatCodeCombo,
} from "./keybindings.js";

const SUMMON = "__summon__"; // recording sentinel for the OS-level summon row

export default function KeybindingsSection({ userSt, saveUser }) {
  const [recordingId, setRecordingId] = useState(null);
  const [error, setError] = useState("");
  const recRef = useRef(recordingId);
  recRef.current = recordingId;

  const { byAction } = resolveBindings(userSt?.keybindings);

  // Summon combo (code-based): string | null (disabled) | undefined (default).
  const summonRaw = userSt?.keybindings?.summon;
  const summonHasOverride = userSt?.keybindings
    && Object.prototype.hasOwnProperty.call(userSt.keybindings, "summon");
  const summonCombo = summonHasOverride ? summonRaw : DEFAULT_SUMMON; // string | null

  const writeBinding = (id, value) => {
    const kb = { ...(userSt?.keybindings || {}) };
    if (value === "__reset__") delete kb[id];
    else kb[id] = value; // string (remap) or null (disabled)
    saveUser({ ...userSt, keybindings: kb });
  };

  // Persist a summon change and (re)register it OS-wide via Rust.
  const applySummon = (value) => {
    const kb = { ...(userSt?.keybindings || {}) };
    if (value === "__reset__") delete kb.summon;
    else kb.summon = value; // string or null (disabled)
    saveUser({ ...userSt, keybindings: kb });
    const effective = value === "__reset__" ? DEFAULT_SUMMON : value;
    invoke("set_summon_shortcut", { combo: effective || "" }).catch((err) => {
      setError(`Couldn't register hotkey: ${err}`);
    });
  };

  // While a row is recording, capture the next real keystroke. The global
  // dispatcher stands down via setCapturing() so e.g. Ctrl+K records here.
  useEffect(() => {
    if (!recordingId) { setCapturing(false); return; }
    setCapturing(true);
    setError("");
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecordingId(null); return; }

      if (recRef.current === SUMMON) {
        const combo = comboFromCode(e);
        if (!combo) return; // lone modifier
        if (!isSummonBindable(combo)) {
          setError("Use Ctrl or Alt (optionally + Shift) plus a key.");
          return;
        }
        applySummon(combo);
        setRecordingId(null);
        return;
      }

      const combo = comboFromEvent(e);
      if (!combo) return; // lone modifier — wait for the real key
      if (!isBindable(combo)) {
        setError("Use Ctrl or Alt (optionally + Shift) plus a key.");
        return;
      }
      const c = canon(combo);
      const clash = KEY_ACTIONS.find(
        (a) => a.id !== recRef.current && byAction.get(a.id) && canon(byAction.get(a.id)) === c
      );
      if (clash) {
        setError(`${formatCombo(combo)} is already used by “${clash.label}”.`);
        return;
      }
      writeBinding(recRef.current, combo);
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setCapturing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, userSt]);

  const rowsByCat = CATEGORY_ORDER.map((cat) => ({
    cat,
    actions: KEY_ACTIONS.filter((a) => a.category === cat),
  })).filter((g) => g.actions.length);

  return (
    <div>
      {rowsByCat.map(({ cat, actions }) => (
        <div key={cat} style={{ marginBottom: "var(--phn-sp-3)" }}>
          <div style={{ fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", opacity: 0.55, margin: "var(--phn-sp-2) 0 4px" }}>
            {cat}
          </div>
          {actions.map((a) => {
            const combo = byAction.get(a.id); // string | null
            const recording = recordingId === a.id;
            const isDefault = !userSt?.keybindings || !Object.prototype.hasOwnProperty.call(userSt.keybindings, a.id);
            return (
              <div
                key={a.id}
                style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "5px 0", borderBottom: "1px solid var(--phn-border, #222)" }}
              >
                <span style={{ flex: 1, fontSize: 13 }}>{a.label}</span>
                <button
                  className="phn-ui-kbd"
                  onClick={() => setRecordingId(recording ? null : a.id)}
                  title="Click, then press the new shortcut (Esc to cancel)"
                  style={{
                    cursor: "pointer",
                    minWidth: 92,
                    textAlign: "center",
                    border: recording ? "1px solid var(--phn-accent, #6cf)" : undefined,
                    color: !combo ? "var(--phn-fg-dim, #888)" : undefined,
                  }}
                >
                  {recording ? "Press keys…" : combo ? formatCombo(combo) : "Disabled"}
                </button>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => writeBinding(a.id, null)}
                  disabled={!combo}
                  title="Unbind this shortcut"
                >
                  disable
                </Button>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => writeBinding(a.id, "__reset__")}
                  disabled={isDefault}
                  title={`Reset to default (${formatCombo(a.default)})`}
                >
                  reset
                </Button>
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ marginBottom: "var(--phn-sp-3)" }}>
        <div style={{ fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", opacity: 0.55, margin: "var(--phn-sp-2) 0 4px" }}>
          Window (system-wide)
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", padding: "5px 0", borderBottom: "1px solid var(--phn-border, #222)" }}>
          <span style={{ flex: 1, fontSize: 13 }}>
            Summon / hide window
            <span style={{ opacity: 0.5, fontSize: 11 }}>&nbsp;— works even when Pluto is not focused</span>
          </span>
          <button
            className="phn-ui-kbd"
            onClick={() => setRecordingId(recordingId === SUMMON ? null : SUMMON)}
            title="Click, then press the new shortcut (Esc to cancel)"
            style={{
              cursor: "pointer", minWidth: 92, textAlign: "center",
              border: recordingId === SUMMON ? "1px solid var(--phn-accent, #6cf)" : undefined,
              color: !summonCombo ? "var(--phn-fg-dim, #888)" : undefined,
            }}
          >
            {recordingId === SUMMON ? "Press keys…" : summonCombo ? formatCodeCombo(summonCombo) : "Disabled"}
          </button>
          <Button variant="subtle" size="sm" onClick={() => applySummon(null)} disabled={!summonCombo} title="Unbind the summon hotkey">
            Disable
          </Button>
          <Button variant="subtle" size="sm" onClick={() => applySummon("__reset__")} disabled={!summonHasOverride} title={`Reset to default (${formatCodeCombo(DEFAULT_SUMMON)})`}>
            Reset
          </Button>
        </div>
      </div>

      {error && (
        <div style={{ color: "var(--phn-danger, #e66)", fontSize: 12, marginTop: 6 }}>{error}</div>
      )}
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 8 }}>
        Find in terminal applies to the focused terminal. The summon hotkey is registered with the OS, so it works from any app.
      </div>
    </div>
  );
}
