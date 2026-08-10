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
  { id: "find",           label: "Find in terminal",       category: "Terminal",   default: "Ctrl+F",       fn: "openFind" },
  { id: "togglePromptEditor", label: "Toggle prompt editor (beta)", category: "Terminal", default: "", fn: "togglePromptEditor" },
  { id: "askAi",          label: "Ask AI",                 category: "AI",         default: "Ctrl+I",       fn: "openAskAi" },
  { id: "agentMode",      label: "Agent Mode",             category: "AI",         default: "Ctrl+Shift+A", fn: "openAgent" },
  { id: "newTab",         label: "New tab",                category: "Tabs",       default: "Ctrl+Shift+T", fn: "addTab" },
  { id: "closeTab",       label: "Close tab",              category: "Tabs",       default: "Ctrl+Shift+W", fn: "closeActiveTab" },
  { id: "reopenTab",      label: "Reopen closed tab",      category: "Tabs",       default: "Ctrl+Shift+Z", fn: "reopenTab" },
  { id: "toggleTheme",    label: "Toggle dark / light",    category: "Appearance", default: "Ctrl+\\",      fn: "toggleTheme" },
  // Panes (splits within a tab). Defaults dodge the shell: Ctrl+D is EOF, so
  // splits ride Ctrl+Shift; focus nav rides Ctrl+Alt because plain Alt+↑/↓ is
  // block jumping (TerminalPane) — on macOS Ctrl+Alt arrives as ⌘⌥ (Cmd folds
  // into Ctrl), which is Warp's pane-nav default.
  { id: "splitRight",     label: "Split pane right",       category: "Panes",      default: "Ctrl+Shift+D", fn: "splitActivePane", arg: "row" },
  { id: "splitDown",      label: "Split pane down",        category: "Panes",      default: "Ctrl+Shift+S", fn: "splitActivePane", arg: "col" },
  { id: "closePane",      label: "Close pane",             category: "Panes",      default: "Ctrl+Shift+X", fn: "closeActivePane" },
  { id: "focusPaneLeft",  label: "Focus pane left",        category: "Panes",      default: "Ctrl+Alt+ArrowLeft",  fn: "focusPane", arg: "left" },
  { id: "focusPaneRight", label: "Focus pane right",       category: "Panes",      default: "Ctrl+Alt+ArrowRight", fn: "focusPane", arg: "right" },
  { id: "focusPaneUp",    label: "Focus pane up",          category: "Panes",      default: "Ctrl+Alt+ArrowUp",    fn: "focusPane", arg: "up" },
  { id: "focusPaneDown",  label: "Focus pane down",        category: "Panes",      default: "Ctrl+Alt+ArrowDown",  fn: "focusPane", arg: "down" },
  // Panel switching — 8 numbered slots; arg is the 0-based panel index.
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `panel${i + 1}`,
    label: `Switch to panel ${i + 1}`,
    category: "Panels",
    default: `Ctrl+${i + 1}`,
    fn: "switchPanel",
    arg: i,
  })),
];

export const CATEGORY_ORDER = ["General", "Terminal", "AI", "Tabs", "Appearance", "Panes", "Panels"];

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

// Shared resolved-bindings cache. TerminalsTab refreshes it each render via
// setResolved(); pane-local handlers (e.g. find-in-terminal in TerminalPane,
// which lives in xterm's key handler, not the global dispatcher) read it
// without needing keybindings threaded through props.
let _resolved = resolveBindings(null);
export function setResolved(userKb) {
  _resolved = resolveBindings(userKb);
  return _resolved;
}
// actionId currently bound to a live KeyboardEvent, or null.
export function actionForEvent(e) {
  const combo = comboFromEvent(e);
  return combo ? _resolved.byCombo.get(combo) || null : null;
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

// ── OS-level summon hotkey ────────────────────────────────────────────────
// The summon hotkey is an OS global shortcut registered in Rust, which keys off
// the physical KeyboardEvent.code (not the produced character — Shift+Backquote
// yields "~" but the OS still sees Backquote). So it gets its own code-based
// representation, e.g. "Ctrl+Shift+Backquote", that the Rust parser mirrors.

export const DEFAULT_SUMMON = "Ctrl+Shift+Backquote";

const CODE_PRETTY = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
  Slash: "/", Space: "Space", Enter: "Enter", Tab: "Tab", Escape: "Esc",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

function prettyCode(code) {
  if (CODE_PRETTY[code]) return CODE_PRETTY[code];
  const k = /^Key([A-Z])$/.exec(code);
  if (k) return k[1];
  const d = /^Digit([0-9])$/.exec(code);
  if (d) return d[1];
  return code; // F1..F12 and anything else
}

// Canonical summon combo from a live event, using physical codes. Null for a
// lone modifier. Ctrl and Meta are kept distinct (Rust maps Meta → SUPER) so a
// mac user could bind Cmd.
export function comboFromCode(e) {
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(e.code) || e.code === "") return null;
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, e.code].join("+");
}

// A summon combo needs a non-Shift modifier + a real key.
export function isSummonBindable(combo) {
  if (!combo) return false;
  const parts = combo.split("+");
  const key = parts.pop();
  if (!key) return false;
  return parts.includes("Ctrl") || parts.includes("Alt") || parts.includes("Meta");
}

export function formatCodeCombo(combo) {
  if (!combo) return "";
  const parts = combo.split("+");
  const key = parts.pop();
  return [...parts, prettyCode(key)].join("+");
}

// Capture guard: while the remap UI is recording a keystroke, the global
// dispatcher must stand down so pressing e.g. Ctrl+K records instead of firing.
let _capturing = false;
export function setCapturing(v) { _capturing = !!v; }
export function isCapturing() { return _capturing; }
