// (C)
import { describe, it, expect } from "vitest";
import { formatCombo, modCombo } from "./keybindings.js";

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
