// (C)
// Multi-LLM model picker (Hermes-style). Pick a provider + model and enter that
// provider's API key; the choice is persisted to user-state and injected as env
// vars into every new shell (see envForModel + TerminalPane spawn), so `claude`
// / `codex` route to it automatically. API keys are stored in the OS keychain (not plaintext localStorage).
//
// Model lists come from the provider itself once its key is set (modelCatalog.js
// -> llm_list_models), so models released after this build still show up. The
// hand-typed lists in providers.js are the fallback.
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { PaneBoundary } from "../../components/ErrorBoundary.jsx";
import { useToast } from "../../components/Toast.jsx";
import { Button, Input, Chip } from "../../components/ui.jsx";
import { PROVIDERS, activeModelProblem, findProvider, isModelId, providerKeyFor, resolveBaseUrl } from "./providers.js";
import {
  PICKER_REFRESH_MS,
  agoLabel,
  isRefreshing,
  listTarget,
  needsRefresh,
  pickerList,
  readModelCache,
  refreshModels,
  useModelCacheVersion,
} from "./modelCatalog.js";
import { openExternal } from "../../appMeta.js";

// A list longer than this gets a filter box; at most MAX_CHIPS chips render.
const FILTER_AT = 24;
const MAX_CHIPS = 60;

const NEW_TAG_STYLE = {
  fontFamily: "var(--phn-ui-font)", fontSize: "var(--phn-fs-2xs)", lineHeight: 1.2,
  border: "1px solid currentColor", borderRadius: "var(--phn-r-sm)", padding: "0 3px",
};

// Never throws: an out-of-range date makes toISOString throw, and a throw here
// takes the whole picker down. normalizeModels already drops such dates; this
// is the second lock, since a render crash costs far more than a missing date.
function chipTitle(m) {
  const t = Number.isFinite(m.created) ? new Date(m.created * 1000) : null;
  const released = t && !Number.isNaN(t.getTime()) ? ` (released ${t.toISOString().slice(0, 10)})` : "";
  return `Use ${m.name || m.id}${released}`;
}

// A saved id as the banner shows it: cut to 60 characters, and every
// character a model id may not hold shown as "?", so a control, bidi or
// invisible character from a synced id cannot reorder or hide anything in
// the line.
const ID_CHAR = /^[A-Za-z0-9._:/@+~=#[\]-]$/;
function displayId(id) {
  let out = "";
  let n = 0;
  for (const ch of String(id ?? "")) {
    if (n++ === 60) break;
    out += ID_CHAR.test(ch) ? ch : "?";
  }
  return out;
}

export default function ModelPicker({ open, onClose, userSt, saveUser }) {
  const toast = useToast();
  const [keys, setKeys] = useState({});
  const [baseUrls, setBaseUrls] = useState({}); // providerId -> custom endpoint
  const [active, setActive] = useState(null); // { providerId, model }
  const [expanded, setExpanded] = useState(null);
  const [custom, setCustom] = useState({}); // providerId -> typed model id
  const [filter, setFilter] = useState({}); // providerId -> filter text
  // The key each provider's list was last fetched with (memory only), so a
  // changed key refetches on blur and an unchanged one does not.
  const lastKey = useRef({});
  // Re-render when a list starts loading, lands, or fails (isRefreshing and
  // readModelCache below are read under this subscription).
  useModelCacheVersion();

  // Hydrate from user-state each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setKeys({ ...(userSt?.providerKeys || {}) });
    setBaseUrls({ ...(userSt?.providerBaseUrls || {}) });
    // The saved choice as it is, even one that cannot be used: every save below
    // writes `active` back, and writing a stand-in would erase the user's
    // choice on this device and, through sync, on the others.
    setActive(userSt?.activeModel || null);
    setExpanded(userSt?.activeModel?.providerId || PROVIDERS[0].id);
    setCustom({});
    setFilter({});
    lastKey.current = { ...(userSt?.providerKeys || {}) };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire and forget: refreshModels never rejects, and the cache subscription
  // above re-renders the row when it starts and when it lands.
  const runRefresh = (providerId, key, base) => { refreshModels(providerId, key, base); };

  // Opening a provider's row loads its live list when the cached one is
  // missing, from another endpoint, or older than an hour. Reads the persisted
  // key (userSt), not the input being typed into, so a half-typed key never
  // goes out.
  useEffect(() => {
    if (!open || !expanded) return;
    const key = userSt?.providerKeys?.[expanded];
    const base = userSt?.providerBaseUrls?.[expanded];
    const target = listTarget(findProvider(expanded), key, base);
    if (target && needsRefresh(readModelCache()[expanded], target.baseUrl, PICKER_REFRESH_MS)) {
      lastKey.current[expanded] = key;
      refreshModels(expanded, key, base);
    }
  }, [open, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (nextKeys, nextActive, nextBaseUrls = baseUrls) => {
    saveUser({ ...userSt, providerKeys: nextKeys, activeModel: nextActive, providerBaseUrls: nextBaseUrls });
  };

  const chooseModel = (providerId, model) => {
    const m = (model || "").trim();
    if (!m) { toast.error("Pick or type a model id first."); return; }
    if (!isModelId(m)) {
      toast.error("A model id uses letters, digits and . _ - : / @ + ~ = # [ ] only, up to 200 characters, and does not start with a dash.");
      return;
    }
    if (!providerKeyFor({ providerKeys: keys, anthropicKey: userSt?.anthropicKey }, providerId)) {
      toast.error("Enter the provider's API key first.");
      return;
    }
    const p = findProvider(providerId);
    if (p?.allowBaseUrl && !String(baseUrls[providerId] || "").trim()) {
      toast.error("Enter the endpoint base URL first.");
      return;
    }
    const next = { providerId, model: m };
    // The checks above cover the common cases; this catches the rest (a base URL
    // with a space in it, say) before a choice that cannot be used is saved.
    const problem = activeModelProblem({ activeModel: next, providerKeys: keys, providerBaseUrls: baseUrls, anthropicKey: userSt?.anthropicKey });
    if (problem) {
      toast.error(`That choice cannot be used: ${problem}.`);
      return;
    }
    setActive(next);
    persist(keys, next, baseUrls);
    toast.success(`Active model: ${m}. New shells route to ${p?.label || providerId}.`);
  };

  const resetDefault = () => {
    setActive(null);
    persist(keys, null, baseUrls);
    toast.success("Reverted to default (your Anthropic key / Claude).");
  };

  const setKey = (providerId, value) => setKeys({ ...keys, [providerId]: value });
  const setBaseUrl = (providerId, value) => setBaseUrls({ ...baseUrls, [providerId]: value });
  const commitKeys = () => persist(keys, active, baseUrls); // save keys + endpoints on blur

  // A new key (pasted or edited) loads that key's list as soon as the field is left.
  const onKeyBlur = (providerId) => {
    commitKeys();
    const key = keys[providerId] || "";
    if (key === (lastKey.current[providerId] || "")) return;
    lastKey.current[providerId] = key;
    if (listTarget(findProvider(providerId), key, baseUrls[providerId])) runRefresh(providerId, key, baseUrls[providerId]);
  };

  // A new endpoint makes the cached list someone else's (needsRefresh compares it).
  const onBaseBlur = (providerId) => {
    commitKeys();
    const target = listTarget(findProvider(providerId), keys[providerId], baseUrls[providerId]);
    if (target && needsRefresh(readModelCache()[providerId], target.baseUrl, PICKER_REFRESH_MS)) {
      runRefresh(providerId, keys[providerId], baseUrls[providerId]);
    }
  };

  // What is wrong with the saved choice, judged against the base URLs as edited
  // here; `shown` is the choice when it can be used.
  const savedProblem = active
    ? activeModelProblem({ activeModel: active, providerKeys: keys, providerBaseUrls: baseUrls, anthropicKey: userSt?.anthropicKey })
    : null;
  const shown = savedProblem ? null : active;
  const activeProvider = shown ? findProvider(shown.providerId) : null;
  const cache = readModelCache();

  return (
    <Modal open={open} title="Models" onClose={onClose} width={640}>
      {/* The rows render lists from provider endpoints, so a render throw is
          caught here, inside the dialog: the fallback shows where the user is
          looking and the dialog's own close still works. */}
      <PaneBoundary label="Models">
      {/* Bounded flex column: pinned banner + footer with ONE scrolling list. */}
      <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 150px)" }}>
        {/* Active model banner */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: "var(--phn-sp-3)", marginBottom: "var(--phn-sp-3)", padding: "var(--phn-sp-2) var(--phn-sp-3)",
            borderRadius: "var(--phn-r-md)", flexShrink: 0, background: "var(--phn-page-bg)",
            border: `1px solid ${shown ? "var(--phn-link)" : "var(--phn-surface-border)"}`,
          }}
        >
          <div style={{ fontSize: "var(--phn-fs-sm)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {shown ? (
              <>
                <span style={{ color: "var(--phn-text-dim)" }}>Active&nbsp;</span>
                <strong style={{ color: "var(--phn-link)", fontFamily: "var(--phn-mono-font)" }}>{shown.model}</strong>
                <span style={{ color: "var(--phn-text-dim)" }}> · {activeProvider?.label || shown.providerId}</span>
              </>
            ) : savedProblem ? (
              <span style={{ color: "var(--phn-text-dim)" }}>Active: none</span>
            ) : (
              <span style={{ color: "var(--phn-text-dim)" }}>Active: default (your Anthropic key → Claude)</span>
            )}
          </div>
          {active && <Button variant="ghost" size="sm" onClick={resetDefault}>Use default</Button>}
        </div>
        {savedProblem && (
          <div role="status" style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-notice-warn-fg, #b8860b)", margin: "calc(-1 * var(--phn-sp-2)) 0 var(--phn-sp-3)" }}>
            Your saved choice ({displayId(active?.model)}) cannot be used: {savedProblem}. Until you pick again or press Use default (which clears it on your synced devices too), new shells and the AI get no model.
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--phn-sp-1)", paddingRight: 4 }}>
          {PROVIDERS.map((p) => {
            const isOpen = expanded === p.id;
            const hasKey = typeof keys[p.id] === "string" && keys[p.id].trim().length > 0;
            const isActive = shown?.providerId === p.id;
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
                  <ProviderBody
                    p={p}
                    keyValue={keys[p.id] || ""}
                    baseValue={baseUrls[p.id] || ""}
                    entry={cache[p.id]}
                    loading={isRefreshing(p.id)}
                    filterText={filter[p.id] || ""}
                    customText={custom[p.id] || ""}
                    activeModel={isActive ? shown.model : null}
                    onKey={(v) => setKey(p.id, v)}
                    onKeyBlur={() => onKeyBlur(p.id)}
                    onBase={(v) => setBaseUrl(p.id, v)}
                    onBaseBlur={() => onBaseBlur(p.id)}
                    onFilter={(v) => setFilter({ ...filter, [p.id]: v })}
                    onCustom={(v) => setCustom({ ...custom, [p.id]: v })}
                    onUse={(m) => chooseModel(p.id, m)}
                    onRefresh={() => runRefresh(p.id, keys[p.id], baseUrls[p.id])}
                  />
                )}
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", marginTop: "var(--phn-sp-3)", lineHeight: "var(--phn-lh)", flexShrink: 0 }}>
          Each row shows what it routes: <strong>Claude Code</strong> (Anthropic-style) or{" "}
          <strong>Codex / OpenAI tools</strong> (OpenAI-style). Once a key is set, the list comes from the
          provider itself, so new models appear without an app update. Pick a chip or type any model id;
          the <em>Custom</em> row points at any OpenAI-compatible endpoint. Open a new tab after
          picking. Env is set at shell spawn. API keys are stored in the OS keychain (not plaintext localStorage).
        </p>
      </div>
      </PaneBoundary>
    </Modal>
  );
}

// One provider's open row: endpoint, key, where its list came from, the list.
function ProviderBody({
  p, keyValue, baseValue, entry, loading, filterText, customText, activeModel,
  onKey, onKeyBlur, onBase, onBaseBlur, onFilter, onCustom, onUse, onRefresh,
}) {
  const target = listTarget(p, keyValue, baseValue);
  const base = resolveBaseUrl(p, baseValue);
  // Without a key the cached list is not this key's to show; use the built-in one.
  const view = pickerList(p, target ? entry : null, base);

  // The filter applies only while its box is on screen: a list that shrinks
  // below FILTER_AT (a cleared key brings the short built-in list back) must
  // not keep a filter the user can no longer see or clear.
  const filterable = view.models.length > FILTER_AT;
  const q = filterable ? filterText.trim().toLowerCase() : "";
  const matches = q
    ? view.models.filter((m) => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q))
    : view.models;
  const shown = matches.slice(0, MAX_CHIPS);

  return (
    <div style={{ padding: `0 var(--phn-sp-3) var(--phn-sp-3) 30px`, display: "flex", flexDirection: "column", gap: "var(--phn-sp-2)" }}>
      {p.allowBaseUrl && (
        <Input
          mono
          value={baseValue}
          onChange={(e) => onBase(e.target.value)}
          onBlur={onBaseBlur}
          placeholder="endpoint base URL (e.g. https://host/v1)"
          aria-label={`${p.label} endpoint base URL`}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)" }}>
        <Input
          type="password"
          value={keyValue}
          onChange={(e) => onKey(e.target.value)}
          onBlur={onKeyBlur}
          placeholder={`${p.label} API key`}
          aria-label={`${p.label} API key`}
        />
        {p.keysUrl && (
          <Button variant="subtle" size="sm" onClick={() => openExternal(p.keysUrl)}>Get key ↗</Button>
        )}
      </div>

      <ListStatus p={p} view={view} hasTarget={!!target} loading={loading} onRefresh={onRefresh} />

      {filterable && (
        <Input
          mono
          value={filterText}
          onChange={(e) => onFilter(e.target.value)}
          placeholder={`Filter ${view.models.length} models`}
          aria-label={`Filter ${p.label} models`}
        />
      )}

      {shown.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--phn-sp-1)" }}>
          {shown.map((m) => (
            <Chip key={m.id} active={activeModel === m.id} onClick={() => onUse(m.id)} title={chipTitle(m)}>
              {m.id}
              {m.isNew && <span style={NEW_TAG_STYLE}>new</span>}
            </Chip>
          ))}
        </div>
      )}
      {matches.length > shown.length && (
        <div style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)" }}>
          Showing {shown.length} of {matches.length}. Type in the filter to narrow the list.
        </div>
      )}
      {q && matches.length === 0 && (
        <div style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)" }}>
          No model matches “{filterText.trim()}”. You can still type its id below.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)" }}>
        <Input
          mono
          value={customText}
          onChange={(e) => onCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onUse(customText); }}
          placeholder="…or type any model id"
          aria-label={`Type a ${p.label} model id`}
        />
        <Button variant="primary" size="sm" onClick={() => onUse(customText)}>Use</Button>
      </div>
    </div>
  );
}

// Where the list on show came from, how fresh it is, and the one action that
// fits: Refresh, Retry, or nothing until there is a key.
function ListStatus({ p, view, hasTarget, loading, onRefresh }) {
  const line = { fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)", lineHeight: "var(--phn-lh)" };
  let text;
  let action = null;
  if (loading) {
    text = "Loading this provider's current models…";
  } else if (view.source === "live") {
    text = `${view.models.length} ${view.models.length === 1 ? "model" : "models"} from the provider · updated ${agoLabel(view.fetchedAt)}`;
    action = "Refresh";
  } else if (!hasTarget) {
    text = p.allowBaseUrl
      ? "Enter the endpoint and its key to load the models it serves."
      : "Built-in list. Enter your key to load this provider's current models.";
  } else if (view.notListed) {
    text = "This address doesn't publish a model list (HTTP 404). Showing the built-in list; type a model id if yours is missing.";
    action = "Retry";
  } else if (view.error) {
    text = `Couldn't load this provider's models (${view.error}). Showing the built-in list.`;
    action = "Retry";
  } else if (view.emptyLive) {
    text = "The provider listed no chat models. Showing the built-in list.";
    action = "Refresh";
  } else {
    text = "Built-in list.";
    action = "Load current models";
  }
  return (
    <div role="status" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", flexWrap: "wrap" }}>
        <span style={line}>{text}</span>
        {action && (
          <Button variant="subtle" size="sm" onClick={onRefresh}>{action}</Button>
        )}
      </div>
      {view.source === "live" && view.error && !loading && (
        // The notice text token, not --phn-warning: that one is a status tint
        // and fails contrast as text on both light skins (RemoteControlModal).
        <span style={{ ...line, color: "var(--phn-notice-warn-fg, #E0A04F)" }}>Last refresh failed: {view.error}</span>
      )}
    </div>
  );
}
