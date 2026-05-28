// (C)
// Multi-LLM model picker (Hermes-style). Pick a provider + model and enter that
// provider's API key; the choice is persisted to user-state and injected as env
// vars into every new shell (see envForModel + TerminalPane spawn), so `claude`
// / `codex` route to it automatically. Keys never leave localStorage.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { PROVIDERS, findProvider } from "./providers.js";
import { openExternal } from "../../appMeta.js";

const ACCENT = "var(--phn-link, #4aa8c0)";
const DIM = "var(--phn-text-dim, #888)";

export default function ModelPicker({ open, onClose, userSt, saveUser }) {
  const toast = useToast();
  const [keys, setKeys] = useState({});
  const [baseUrls, setBaseUrls] = useState({}); // providerId -> custom endpoint
  const [active, setActive] = useState(null); // { providerId, model }
  const [expanded, setExpanded] = useState(null);
  const [custom, setCustom] = useState({}); // providerId -> typed model id

  // Hydrate from user-state each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setKeys({ ...(userSt?.providerKeys || {}) });
    setBaseUrls({ ...(userSt?.providerBaseUrls || {}) });
    setActive(userSt?.activeModel || null);
    setExpanded(userSt?.activeModel?.providerId || PROVIDERS[0].id);
    setCustom({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (nextKeys, nextActive, nextBaseUrls = baseUrls) => {
    saveUser({ ...userSt, providerKeys: nextKeys, activeModel: nextActive, providerBaseUrls: nextBaseUrls });
  };

  const useModel = (providerId, model) => {
    const m = (model || "").trim();
    if (!m) { toast.error("Pick or type a model id first."); return; }
    if (!keys[providerId] || !keys[providerId].trim()) {
      toast.error("Enter the provider's API key first.");
      return;
    }
    const p = findProvider(providerId);
    if (p?.allowBaseUrl && !(baseUrls[providerId] || "").trim()) {
      toast.error("Enter the endpoint base URL first.");
      return;
    }
    const next = { providerId, model: m };
    setActive(next);
    persist(keys, next, baseUrls);
    toast.success(`Active model: ${m} — new shells route to ${p?.label || providerId}.`);
  };

  const resetDefault = () => {
    setActive(null);
    persist(keys, null, baseUrls);
    toast.success("Reverted to default (your Anthropic key / Claude).");
  };

  const setKey = (providerId, value) => {
    const next = { ...keys, [providerId]: value };
    setKeys(next);
  };
  const setBaseUrl = (providerId, value) => {
    setBaseUrls({ ...baseUrls, [providerId]: value });
  };
  const commitKeys = () => persist(keys, active, baseUrls); // save keys + endpoints on blur

  const activeProvider = active ? findProvider(active.providerId) : null;

  return (
    <Modal open={open} title="Models — pick a provider + model" onClose={onClose} width={640}>
      {/* Bounded flex column: pinned banner + footer with ONE scrolling list.
          Avoids the double-scroll/cutoff from nesting a scroll area inside the
          already-scrolling .phn-modal. */}
      <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 150px)" }}>
      {/* Active model banner */}
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 10, marginBottom: 12, padding: "8px 12px", borderRadius: 6, flexShrink: 0,
          background: "var(--phn-page-bg, #1c1c1c)",
          border: `1px solid ${active ? ACCENT : "var(--phn-surface-border, #151515)"}`,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--phn-text-fg, #d4d4d4)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active ? (
            <>
              <span style={{ color: DIM }}>Active: </span>
              <strong style={{ color: ACCENT }}>{active.model}</strong>
              <span style={{ color: DIM }}> · {activeProvider?.label || active.providerId}</span>
            </>
          ) : (
            <span style={{ color: DIM }}>Active: default (your Anthropic key → Claude)</span>
          )}
        </div>
        {active && (
          <button onClick={resetDefault} style={ghostBtn}>Use default</button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
        {PROVIDERS.map((p) => {
          const isOpen = expanded === p.id;
          const hasKey = keys[p.id] && keys[p.id].trim().length > 0;
          const isActive = active?.providerId === p.id;
          return (
            <div
              key={p.id}
              style={{
                border: `1px solid ${isActive ? ACCENT : "var(--phn-surface-border, #2a2a2a)"}`,
                borderRadius: 6, overflow: "hidden",
                background: "var(--phn-surface-bg, #242424)",
              }}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : p.id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", background: "transparent", border: "none",
                  cursor: "pointer", color: "var(--phn-text-fg, #d4d4d4)", textAlign: "left",
                  fontFamily: "var(--phn-ui-font)", fontSize: 12.5, fontWeight: 600,
                }}
              >
                <span style={{ color: DIM, fontSize: 10, width: 10 }}>{isOpen ? "▾" : "▸"}</span>
                <span style={{ flex: 1 }}>{p.label}</span>
                {hasKey && <span style={{ fontSize: 9, color: "#5fd75f" }}>● key set</span>}
                <span style={{ fontSize: 9, color: DIM, fontWeight: 400 }}>{p.runsWith}</span>
              </button>

              {isOpen && (
                <div style={{ padding: "4px 12px 12px 30px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {p.allowBaseUrl && (
                    <input
                      value={baseUrls[p.id] || ""}
                      onChange={(e) => setBaseUrl(p.id, e.target.value)}
                      onBlur={commitKeys}
                      placeholder="endpoint base URL (e.g. https://host/v1)"
                      style={{ ...input, fontFamily: "'MesloLGS NF', monospace", fontSize: 11 }}
                    />
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="password"
                      value={keys[p.id] || ""}
                      onChange={(e) => setKey(p.id, e.target.value)}
                      onBlur={commitKeys}
                      placeholder={`${p.label} API key`}
                      style={input}
                    />
                    {p.keysUrl && (
                      <button onClick={() => openExternal(p.keysUrl)} style={{ fontSize: 10, color: ACCENT, whiteSpace: "nowrap", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                        get key ↗
                      </button>
                    )}
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {p.models.map((m) => {
                      const sel = isActive && active.model === m;
                      return (
                        <button
                          key={m}
                          onClick={() => useModel(p.id, m)}
                          title="Use this model"
                          style={{
                            ...chip,
                            background: sel ? ACCENT : "var(--phn-page-bg, #1c1c1c)",
                            color: sel ? "#06223a" : "var(--phn-text-fg, #d4d4d4)",
                            borderColor: sel ? ACCENT : "var(--phn-surface-border, #2a2a2a)",
                          }}
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      value={custom[p.id] || ""}
                      onChange={(e) => setCustom({ ...custom, [p.id]: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") useModel(p.id, custom[p.id]); }}
                      placeholder="…or type any model id"
                      style={{ ...input, fontFamily: "'MesloLGS NF', monospace", fontSize: 11 }}
                    />
                    <button onClick={() => useModel(p.id, custom[p.id])} style={ghostBtn}>Use</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 10.5, color: DIM, marginTop: 10, lineHeight: 1.5, flexShrink: 0 }}>
        Each row shows what it routes: <strong>Claude Code</strong> (Anthropic-style) or{" "}
        <strong>Codex / OpenAI tools</strong> (OpenAI-style). Pick a chip or type any model id;
        the <em>Custom</em> row points at any OpenAI-compatible endpoint. Open a new tab after
        picking — env is set at shell spawn. Keys never leave localStorage.
      </p>
      </div>
    </Modal>
  );
}

const input = {
  flex: 1, background: "var(--phn-page-bg, #1c1c1c)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 4,
  color: "var(--phn-text-fg, #d4d4d4)", padding: "5px 8px", fontSize: 12,
  fontFamily: "var(--phn-ui-font)", outline: "none",
};
const chip = {
  padding: "3px 9px", borderRadius: 4, border: "1px solid", cursor: "pointer",
  fontSize: 11, fontFamily: "'MesloLGS NF', monospace",
};
const ghostBtn = {
  background: "transparent", border: `1px solid ${ACCENT}`, color: ACCENT,
  padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
