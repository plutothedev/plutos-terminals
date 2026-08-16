// (C)
import { describe, it, expect } from "vitest";
import {
  formatCombo, modCombo, canon, isBindable, resolveBindings, setResolved,
  isSummonBindable, formatCodeCombo, KEY_ACTIONS,
} from "./keybindings.js";

// Platform-aware shortcut DISPLAY. Handling already collapses Cmd/Ctrl into
// one canonical "Ctrl" token (`e.ctrlKey || e.metaKey`), but several labels
// hardcoded the mac ⌘ glyph — a Windows user's bottom bar read "⌘I Ask AI"
// for a shortcut they press as Ctrl+I. Display must follow the platform:
// Windows/Linux spell "Ctrl+K"; macOS uses the native glyph run "⌘K".

describe("modCombo", () => {
  it("spells Ctrl+<key> on Windows/Linux", () => {
    expect(modCombo("K", { mac: false })).toBe("Ctrl+K");
    expect(modCombo("Enter", { mac: false })).toBe("Ctrl+Enter");
  });

  it("uses the ⌘ glyph run on macOS", () => {
    expect(modCombo("K", { mac: true })).toBe("⌘K");
    expect(modCombo("Enter", { mac: true })).toBe("⌘Enter");
  });
});

describe("formatCombo platform rendering", () => {
  it("keeps canonical Ctrl+ spelling off-mac", () => {
    expect(formatCombo("Ctrl+Shift+T", { mac: false })).toBe("Ctrl+Shift+T");
    expect(formatCombo("Ctrl+K", { mac: false })).toBe("Ctrl+K");
  });

  it("renders mac glyphs joined without separators on mac", () => {
    expect(formatCombo("Ctrl+K", { mac: true })).toBe("⌘K");
    expect(formatCombo("Ctrl+Shift+T", { mac: true })).toBe("⌘⇧T");
    expect(formatCombo("Ctrl+Alt+ArrowLeft", { mac: true })).toBe("⌘⌥←");
  });

  it("still prettifies bare keys and defaults to the runtime platform", () => {
    // No opts: must not throw and must return a non-empty string either way.
    expect(formatCombo("Ctrl+K").length).toBeGreaterThan(0);
    expect(formatCombo("")).toBe("");
  });
});

// Corrupt/hostile binding data must never throw. userSt.keybindings is
// user-editable AND cloud-synced (sync/merge.js takes remote scalars verbatim),
// so a binding value can be any JSON. resolveBindings runs inside a render-time
// useMemo in TerminalsTab, and a throw there trips the top-level boundary, whose
// destroyAll() kills every live SSH/serial/local session in the window.
describe("total over arbitrary JSON binding data", () => {
  const JUNK = [42, 0, { a: 1 }, ["Ctrl", "K"], true, false, NaN, undefined, null];
  const CMD_DEFAULT = KEY_ACTIONS.find((a) => a.id === "commandPalette").default;

  it("canon survives every junk shape", () => {
    for (const v of JUNK) expect(() => canon(v)).not.toThrow();
    expect(canon(42)).toBe("");
    expect(canon({})).toBe("");
    expect(canon(["Ctrl", "K"])).toBe("");
    expect(canon(null)).toBe(null);      // falsy passthrough preserved
    expect(canon(undefined)).toBe(undefined);
    expect(canon("ctrl+k")).toBe("Ctrl+K"); // real combos still normalize
  });

  it("isBindable / formatCombo / summon helpers reject junk instead of throwing", () => {
    for (const v of JUNK) {
      expect(() => isBindable(v)).not.toThrow();
      expect(isBindable(v)).toBe(false);
      expect(() => formatCombo(v)).not.toThrow();
      expect(formatCombo(v)).toBe("");
      expect(() => isSummonBindable(v)).not.toThrow();
      expect(isSummonBindable(v)).toBe(false);
      expect(() => formatCodeCombo(v)).not.toThrow();
      expect(formatCodeCombo(v)).toBe("");
    }
  });

  it("resolveBindings falls back to the default for a non-string, non-null override", () => {
    for (const bad of [42, { a: 1 }, ["Ctrl", "K"], true, undefined, NaN]) {
      const r = resolveBindings({ commandPalette: bad });
      expect(r.byAction.get("commandPalette")).toBe(CMD_DEFAULT);
      expect(r.byCombo.get(canon(CMD_DEFAULT))).toBe("commandPalette");
    }
  });

  it("still honours the two legitimate override shapes", () => {
    expect(resolveBindings({ commandPalette: "Ctrl+J" }).byAction.get("commandPalette")).toBe("Ctrl+J");
    expect(resolveBindings({ commandPalette: "Ctrl+J" }).byCombo.get("Ctrl+J")).toBe("commandPalette");
    const disabled = resolveBindings({ commandPalette: null });
    expect(disabled.byAction.get("commandPalette")).toBe(null);
    expect(disabled.byCombo.get(canon(CMD_DEFAULT))).toBeUndefined();
  });

  it("resolveBindings survives a keybindings blob that is not a plain object", () => {
    for (const blob of [null, undefined, 42, "Ctrl+K", ["Ctrl+K"], true]) {
      let r;
      expect(() => { r = resolveBindings(blob); }).not.toThrow();
      expect(r.byAction.get("commandPalette")).toBe(CMD_DEFAULT);
    }
  });

  it("a fully corrupt blob still yields every default binding, never a throw", () => {
    const blob = {};
    for (const a of KEY_ACTIONS) blob[a.id] = { nope: true };
    let r;
    expect(() => { r = setResolved(blob); }).not.toThrow();
    for (const a of KEY_ACTIONS) expect(r.byAction.get(a.id)).toBe(a.default);
    // Nothing bogus leaked into the dispatch map.
    expect(r.byCombo.has("")).toBe(false);
    setResolved(null); // restore the shared cache for other suites
  });
});
