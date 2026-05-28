// (C)
// Multi-LLM model picker (Hermes-style). Pick a provider + model and enter that
// provider's API key; the choice is persisted to user-state and injected as env
// vars into every new shell (see envForModel + TerminalPane spawn), so `claude`
// / `codex` route to it automatically. Keys never leave localStorage.
import { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";
import { Button, Input, Chip } from "../../components/ui.jsx";
import { PROVIDERS, findProvider } from "./providers.js";
import { openExternal } from "../../appMeta.js";

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

  const setKey = (providerId, value) => setKeys({ ...keys, [providerId]: value });
  const setBaseUrl = (providerId, value) => setBaseUrls({ ...baseUrls, [providerId]: value });
  const commitKeys = () => persist(keys, active, baseUrls); // save keys + endpoints on blur

  const activeProvider = active ? findProvider(active.providerId) : null;

  return (
    <Modal open={open} title="Models" onClose={onClose} width={640}>
      {/* Bounded flex column: pinned banner + footer with ONE scrolling list. */}
      <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 150px)" }}>
        {/* Active model banner */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: "var(--phn-sp-3)", marginBottom: "var(--phn-sp-3)", padding: "var(--phn-sp-2) var(--phn-sp-3)",
            borderRadius: "var(--phn-r-md)", flexShrink: 0, background: "var(--phn-page-bg)",
            border: `1px solid ${active ? "var(--phn-link)" : "var(--phn-surface-border)"}`,
          }}
        >
          <div style={{ fontSize: "var(--phn-fs-sm)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {active ? (
              <>
                <span style={{ color: "var(--phn-text-dim)" }}>Active&nbsp;</span>
                <strong style={{ color: "var(--phn-link)", fontFamily: "var(--phn-mono-font)" }}>{active.model}</strong>
                <span style={{ color: "var(--phn-text-dim)" }}> · {activeProvider?.label || active.providerId}</span>
              </>
            ) : (
              <span style={{ color: "var(--phn-text-dim)" }}>Active: default (your Anthropic key → Claude)</span>
            )}
          </div>
          {active && <Button variant="ghost" size="sm" onClick={resetDefault}>Use default</Button>}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--phn-sp-1)", paddingRight: 4 }}>
          {PROVIDERS.map((p) => {
            const isOpen = expanded === p.id;
            const hasKey = keys[p.id] && keys[p.id].trim().length > 0;
            const isActive = active?.providerId === p.id;
            return (
              <div
                key={p.id}
                style={{
                  border: `1px solid ${isActive ? "var(--phn-link)" : "var(--phn-surface-border)"}`,
                  borderRadius: "var(--phn-r-md)", overflow: "hidden", flexShrink: 0,
                  background: "var(--phn-surface-bg)",
                }}
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : p.id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: "var(--phn-sp-2)",
                    padding: "var(--phn-sp-2) var(--phn-sp-3)", background: "transparent", border: "none",
                    cursor: "pointer", color: "var(--phn-text-active)", textAlign: "left",
                    fontFamily: "var(--phn-ui-font)", fontSize: "var(--phn-fs-sm)", fontWeight: 600,
                  }}
                >
                  <span style={{ color: "var(--phn-text-dim)", fontSize: 10, width: 10 }}>{isOpen ? "▾" : "▸"}</span>
                  <span style={{ flex: 1 }}>{p.label}</span>
                  {hasKey && <span style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-success)" }}>● key set</span>}
                  <span style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)", fontWeight: 400 }}>{p.runsWith}</span>
                </button>

                {isOpen && (
                  <div style={{ padding: `0 var(--phn-sp-3) var(--phn-sp-3) 30px`, display: "flex", flexDirection: "column", gap: "var(--phn-sp-2)" }}>
                    {p.allowBaseUrl && (
                      <Input
                        mono
                        value={baseUrls[p.id] || ""}
                        onChange={(e) => setBaseUrl(p.id, e.target.value)}
                        onBlur={commitKeys}
                        placeholder="endpoint base URL (e.g. https://host/v1)"
                      />
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)" }}>
                      <Input
                        type="password"
                        value={keys[p.id] || ""}
                        onChange={(e) => setKey(p.id, e.target.value)}
                        onBlur={commitKeys}
                        placeholder={`${p.label} API key`}
                      />
                      {p.keysUrl && (
                        <Button variant="subtle" size="sm" onClick={() => openExternal(p.keysUrl)}>get key ↗</Button>
                      )}
                    </div>

                    {p.models.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--phn-sp-1)" }}>
                        {p.models.map((m) => (
                          <Chip key={m} active={isActive && active.model === m} onClick={() => useModel(p.id, m)} title="Use this model">
                            {m}
                          </Chip>
                        ))}
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)" }}>
                      <Input
                        mono
                        value={custom[p.id] || ""}
                        onChange={(e) => setCustom({ ...custom, [p.id]: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") useModel(p.id, custom[p.id]); }}
                        placeholder="…or type any model id"
                      />
                      <Button variant="primary" size="sm" onClick={() => useModel(p.id, custom[p.id])}>Use</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)", flexShrink: 0 }}>
          Each row shows what it routes: <strong>Claude Code</strong> (Anthropic-style) or{" "}
          <strong>Codex / OpenAI tools</strong> (OpenAI-style). Pick a chip or type any model id;
          the <em>Custom</em> row points at any OpenAI-compatible endpoint. Open a new tab after
          picking — env is set at shell spawn. Keys never leave localStorage.
        </p>
      </div>
    </Modal>
  );
}
