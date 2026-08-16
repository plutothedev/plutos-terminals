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
// Stored tokens come out of user state, which is arbitrary JSON (see canon), so
// anything non-string degrades to "" rather than falling through to `.length`.
function normKey(raw) {
  if (typeof raw !== "string" || raw === "") return "";
  if (raw === " " || raw === "Spacebar") return "Space";
  if (raw.length === 1) return raw.toUpperCase(); // letters, digits, punctuation
  return raw; // named keys: ArrowUp, Enter, Tab, F1, …
}

// Re-order modifiers + normalize the key so two spellings of the same combo
// compare equal. Tolerates a trailing "+" meaning the literal "+" key.
//
// Combos reach here from userSt.keybindings, which is user-editable AND
// cloud-synced (sync/merge.js:36 takes remote scalars verbatim, no type check),
// so a combo is arbitrary JSON: a number, object or array from a corrupt blob, a
// bad merge, or a hand-edited localStorage. `.split` on one of those threw, and
// this runs inside TerminalsTab's render-time resolveBindings useMemo: a throw
// there hits the top-level error boundary, whose destroyAll() kills EVERY live
// SSH/serial/local session in the window. Truthy non-strings degrade to "";
// falsy values still pass through verbatim so callers' `if (!combo)` guards and
// identity comparisons behave exactly as before.
export function canon(combo) {
  if (!combo) return combo;
  if (typeof combo !== "string") return "";
  const parts = combo.split("+");
  let key = parts.pop();
  if (key === "" && combo.endsWith("+")) key = "+";
  const mods = parts.filter(Boolean).map((m) => m.toLowerCase());
  const ordered = MOD_ORDER.filter((m) => mods.includes(m.toLowerCase()));
  return [...ordered, normKey(key)].join("+");
}

// Build a canonical combo from a live KeyboardEvent, or null for a lone modifier.
export function comboFromEvent(e) {
  if (!e || LONE_MODS.includes(e.key)) return null;
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
  if (typeof combo !== "string" || !combo) return false; // see canon: combo is arbitrary JSON
  const c = canon(combo);
  const parts = c.split("+");
  const key = parts.pop();
  if (!key || ["Ctrl", "Alt", "Shift", "Meta"].includes(key)) return false;
  return parts.includes("Ctrl") || parts.includes("Alt") || parts.includes("Meta");
}

// Resolve defaults + user overrides into lookup maps.
//   byCombo:  canonical combo  -> actionId   (only enabled bindings)
//   byAction: actionId         -> combo | null
//
// Total over arbitrary JSON (see canon for why a throw here is session-fatal): a
// userKb that is not a plain object, and any override that is neither a string
// nor null, degrade to the built-in defaults instead of propagating a bad shape.
export function resolveBindings(userKb) {
  const byCombo = new Map();
  const byAction = new Map();
  const kb = userKb && typeof userKb === "object" && !Array.isArray(userKb) ? userKb : null;
  for (const a of KEY_ACTIONS) {
    let combo = a.default;
    if (kb && Object.prototype.hasOwnProperty.call(kb, a.id)) {
      const override = kb[a.id];
      // string = remap, null = explicitly disabled. Anything else is corrupt and
      // keeps the default, undefined included: JSON persistence drops undefined
      // values, so an own-property undefined is the same as a missing key.
      if (typeof override === "string" || override === null) combo = override;
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

// Is this window on macOS? Combos are STORED canonically as "Ctrl+…" on every
// platform (Cmd collapses into Ctrl at dispatch), so platform only affects
// DISPLAY: Windows/Linux spell "Ctrl+K", macOS shows the native glyph run "⌘K".
export const IS_MAC = /mac/i.test(
  (typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || ""
);

const MAC_MOD_GLYPHS = { Ctrl: "⌘", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

// Platform label for the primary modifier + key, for hardcoded UI hints
// (bottom bar chips, "run now" titles): modCombo("K") → "Ctrl+K" / "⌘K".
export function modCombo(key, { mac = IS_MAC } = {}) {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

// Human display of a combo, e.g. "Ctrl+Shift+T" → "Ctrl+Shift+T" on
// Windows/Linux, "⌘⇧T" on macOS. `mac` is injectable for tests.
export function formatCombo(combo, { mac = IS_MAC } = {}) {
  if (typeof combo !== "string" || !combo) return ""; // see canon: combo is arbitrary JSON
  const c = canon(combo);
  const parts = c.split("+");
  let key = parts.pop();
  if (key === "" && c.endsWith("+")) key = "+";
  const pretty = KEY_PRETTY[key] || key;
  if (mac) return [...parts.map((p) => MAC_MOD_GLYPHS[p] || p), pretty].join("");
  return [...parts, pretty].join("+");
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
  if (!e || typeof e.code !== "string" || e.code === "") return null;
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(e.code)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, e.code].join("+");
}

// A summon combo needs a non-Shift modifier + a real key.
export function isSummonBindable(combo) {
  if (typeof combo !== "string" || !combo) return false; // see canon: combo is arbitrary JSON
  const parts = combo.split("+");
  const key = parts.pop();
  if (!key) return false;
  return parts.includes("Ctrl") || parts.includes("Alt") || parts.includes("Meta");
}

// Same hazard as canon, second entry point: userSt.keybindings.summon renders
// through here (KeybindingsSection), and it is user-editable + cloud-synced too.
export function formatCodeCombo(combo) {
  if (typeof combo !== "string" || !combo) return "";
  const parts = combo.split("+");
  const key = parts.pop();
  return [...parts, prettyCode(key)].join("+");
}

// Capture guard: while the remap UI is recording a keystroke, the global
// dispatcher must stand down so pressing e.g. Ctrl+K records instead of firing.
let _capturing = false;
export function setCapturing(v) { _capturing = !!v; }
export function isCapturing() { return _capturing; }
