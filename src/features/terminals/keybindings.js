// (C)
// Central keybinding registry + combo helpers shared by the global shortcut
// dispatcher (TerminalsTab) and the Settings → Keybindings remap UI.
//
// A "combo" is a canonical human string like "Ctrl+Shift+A". Ctrl and Cmd (⌘)
// collapse to a single "Ctrl" token so one binding works on Windows + macOS,
// matching the historical dispatcher which checked `e.ctrlKey || e.metaKey`.
//
// User overrides live in userSt.keybindings as { [actionId]: combo | null }:
//   - a string  → remapped combo
//   - null      → explicitly disabled
//   - missing   → fall back to the action's default
//
// Each action carries `fn`, the key into shortcutsRef.current that runs it.

export const KEY_ACTIONS = [
  { id: "commandPalette", label: "Command palette",        category: "General",    default: "Ctrl+K",       fn: "openCommandPalette" },
  { id: "history",        label: "Command history search", category: "General",    default: "Ctrl+R",       fn: "openHistory" },
  { id: "settings",       label: "Settings",               category: "General",    default: "Ctrl+,",       fn: "openSettings" },
  { id: "askAi",          label: "Ask AI",                 category: "AI",         default: "Ctrl+I",       fn: "openAskAi" },
  { id: "agentMode",      label: "Agent Mode",             category: "AI",         default: "Ctrl+Shift+A", fn: "openAgent" },
  { id: "newTab",         label: "New tab",                category: "Tabs",       default: "Ctrl+Shift+T", fn: "addTab" },
  { id: "closeTab",       label: "Close tab",              category: "Tabs",       default: "Ctrl+Shift+W", fn: "closeActiveTab" },
  { id: "reopenTab",      label: "Reopen closed tab",      category: "Tabs",       default: "Ctrl+Shift+Z", fn: "reopenTab" },
  { id: "toggleTheme",    label: "Toggle dark / light",    category: "Appearance", default: "Ctrl+\\",      fn: "toggleTheme" },
];

export const CATEGORY_ORDER = ["General", "AI", "Tabs", "Appearance"];

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
const LONE_MODS = ["Control", "Alt", "Shift", "Meta", "Os", "OS", "ContextMenu", "Dead"];

// Pretty single-key display: keep canonical form but tidy a few names.
const KEY_PRETTY = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  " ": "Space", Space: "Space", Escape: "Esc",
};

// Normalize a raw KeyboardEvent.key (or a stored key token) to canonical form.
function normKey(raw) {
  if (raw == null || raw === "") return "";
  if (raw === " " || raw === "Spacebar") return "Space";
  if (raw.length === 1) return raw.toUpperCase(); // letters, digits, punctuation
  return raw; // named keys: ArrowUp, Enter, Tab, F1, …
}

// Re-order modifiers + normalize the key so two spellings of the same combo
// compare equal. Tolerates a trailing "+" meaning the literal "+" key.
export function canon(combo) {
  if (!combo) return combo;
  const parts = combo.split("+");
  let key = parts.pop();
  if (key === "" && combo.endsWith("+")) key = "+";
  const mods = parts.filter(Boolean).map((m) => m.toLowerCase());
  const ordered = MOD_ORDER.filter((m) => mods.includes(m.toLowerCase()));
  return [...ordered, normKey(key)].join("+");
}

// Build a canonical combo from a live KeyboardEvent, or null for a lone modifier.
export function comboFromEvent(e) {
  if (LONE_MODS.includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl"); // Cmd folds into Ctrl
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = normKey(e.key);
  if (!key) return null;
  return [...mods, key].join("+");
}

// A combo is dispatchable only if it carries a non-Shift modifier — otherwise it
// would clobber plain typing in the terminal.
export function isBindable(combo) {
  if (!combo) return false;
  const c = canon(combo);
  const parts = c.split("+");
  const key = parts.pop();
  if (!key || ["Ctrl", "Alt", "Shift", "Meta"].includes(key)) return false;
  return parts.includes("Ctrl") || parts.includes("Alt") || parts.includes("Meta");
}

// Resolve defaults + user overrides into lookup maps.
//   byCombo:  canonical combo  -> actionId   (only enabled bindings)
//   byAction: actionId         -> combo | null
export function resolveBindings(userKb) {
  const byCombo = new Map();
  const byAction = new Map();
  for (const a of KEY_ACTIONS) {
    let combo = a.default;
    if (userKb && Object.prototype.hasOwnProperty.call(userKb, a.id)) {
      combo = userKb[a.id]; // string or null (disabled)
    }
    byAction.set(a.id, combo);
    if (combo) byCombo.set(canon(combo), a.id);
  }
  return { byCombo, byAction };
}

// Human display of a combo, e.g. "Ctrl+Shift+T" → "Ctrl Shift T" tokens.
export function formatCombo(combo) {
  if (!combo) return "";
  const c = canon(combo);
  const parts = c.split("+");
  let key = parts.pop();
  if (key === "" && c.endsWith("+")) key = "+";
  return [...parts, KEY_PRETTY[key] || key].join("+");
}

// Capture guard: while the remap UI is recording a keystroke, the global
// dispatcher must stand down so pressing e.g. Ctrl+K records instead of firing.
let _capturing = false;
export function setCapturing(v) { _capturing = !!v; }
export function isCapturing() { return _capturing; }
