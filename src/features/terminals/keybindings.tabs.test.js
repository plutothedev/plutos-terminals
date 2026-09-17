// (C)
// Audit A11Y-05: there was no keyboard path to switch tabs. `KEY_ACTIONS` had
// newTab / closeTab / reopenTab and nothing else on that axis (Ctrl+1..8 is
// switchPanel, a different one), so with five tabs open the only non-mouse
// route back to tab 1 was Ctrl+Shift+W four times, killing four live PTYs.
// And because the ACTION did not exist, a user could not add the binding
// themselves: Settings → Keybindings can only remap what lives in the registry.
//
// These tests pin three separate things, because "the action exists" is the
// weakest of the three and on its own would pass while the key still did
// nothing:
//   1. the registry entries exist with the arguments the handlers expect;
//   2. a real KeyboardEvent shape resolves through the SAME lookup the global
//      dispatcher uses (comboFromEvent → resolved byCombo map);
//   3. every action's `fn` is actually wired into TerminalsTab's shortcuts
//      object. That is the silent-no-op gap an unwired action falls into
//      (`if (action && fns[action.fn])`).
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import {
  KEY_ACTIONS, CATEGORY_ORDER, canon, isBindable,
  resolveBindings, setResolved, actionForEvent,
} from "./keybindings.js";

const byId = (id) => KEY_ACTIONS.find((a) => a.id === id);

// Restore the shared module-level cache for any suite that runs after us.
afterAll(() => setResolved(null));

describe("tab-navigation actions exist in the registry", () => {
  it("registers next/previous tab with the step the handler applies", () => {
    expect(byId("nextTab")).toMatchObject({ category: "Tabs", fn: "switchTabRel", arg: 1 });
    expect(byId("prevTab")).toMatchObject({ category: "Tabs", fn: "switchTabRel", arg: -1 });
  });

  it("registers nine go-to-tab slots carrying 0-based indices", () => {
    for (let i = 1; i <= 9; i++) {
      expect(byId(`tab${i}`)).toMatchObject({ category: "Tabs", fn: "switchTabIndex", arg: i - 1 });
    }
    expect(byId("tab10")).toBeUndefined();
  });

  it("puts them in a category the Settings UI actually renders", () => {
    // KeybindingsSection builds its rows from CATEGORY_ORDER; an action in an
    // unlisted category is invisible and therefore still unbindable.
    expect(CATEGORY_ORDER).toContain("Tabs");
  });
});

describe("defaults are dispatchable and do not collide", () => {
  const NEW_IDS = ["nextTab", "prevTab", ...Array.from({ length: 9 }, (_, i) => `tab${i + 1}`)];

  it("every default carries a non-Shift modifier", () => {
    // The global dispatcher bails on `!(ctrlKey || metaKey || altKey)` so it
    // never swallows plain typing; a Shift-only default would be dead on
    // arrival, and isBindable enforces the same rule in the remap UI.
    for (const id of NEW_IDS) expect(isBindable(byId(id).default)).toBe(true);
  });

  it("no two actions ship the same default combo", () => {
    const seen = new Map();
    for (const a of KEY_ACTIONS) {
      if (!a.default) continue; // "" = intentionally unbound
      const c = canon(a.default);
      expect(seen.has(c), `${c} is claimed by both ${seen.get(c)} and ${a.id}`).toBe(false);
      seen.set(c, a.id);
    }
  });

  it("keeps go-to-tab off Ctrl+digit, which is panel switching", () => {
    for (let i = 1; i <= 8; i++) expect(byId(`panel${i}`).default).toBe(`Ctrl+${i}`);
    for (let i = 1; i <= 9; i++) expect(byId(`tab${i}`).default).not.toBe(`Ctrl+${i}`);
  });
});

describe("live keystrokes resolve to the tab actions", () => {
  // The exact path TerminalsTab's window-capture handler takes: setResolved
  // (from userSt.keybindings) then actionForEvent on the raw KeyboardEvent.
  const press = (e) => { setResolved(null); return actionForEvent({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...e }); };

  it("Ctrl+Tab / Ctrl+Shift+Tab reach next/previous tab", () => {
    expect(press({ key: "Tab", ctrlKey: true })).toBe("nextTab");
    expect(press({ key: "Tab", ctrlKey: true, shiftKey: true })).toBe("prevTab");
  });

  it("Cmd folds into Ctrl, so the mac spelling resolves too", () => {
    expect(press({ key: "Tab", metaKey: true })).toBe("nextTab");
  });

  it("Alt+N reaches the matching go-to-tab slot", () => {
    expect(press({ key: "1", altKey: true })).toBe("tab1");
    expect(press({ key: "5", altKey: true })).toBe("tab5");
    expect(press({ key: "9", altKey: true })).toBe("tab9");
  });

  it("does not fire on a bare Tab or a bare digit", () => {
    expect(press({ key: "Tab" })).toBeNull();
    expect(press({ key: "3" })).toBeNull();
  });

  it("a user remap moves the action and frees the default", () => {
    setResolved({ nextTab: "Ctrl+PageDown" });
    expect(actionForEvent({ key: "PageDown", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe("nextTab");
    expect(actionForEvent({ key: "Tab", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBeNull();
  });

  it("a user disable (null) unbinds without disturbing its siblings", () => {
    const { byCombo } = resolveBindings({ tab1: null });
    expect(byCombo.get(canon("Alt+1"))).toBeUndefined();
    expect(byCombo.get(canon("Alt+2"))).toBe("tab2");
  });
});

describe("every action is wired to a handler in TerminalsTab", () => {
  // A source scan, deliberately: the shortcuts object is built inside
  // TerminalsTab's render closure and cannot be imported. The dispatcher
  // swallows an unwired action silently (`if (action && fns[action.fn])`), so
  // without this an action can ship, appear in Settings, and do nothing.
  const src = readFileSync(new URL("./TerminalsTab.jsx", import.meta.url), "utf8");
  const start = src.indexOf("shortcutsRef.current = {");
  const block = src.slice(start, src.indexOf("\n    };", start));

  it("finds the shortcuts object", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(100);
  });

  it("declares a handler for every registry fn", () => {
    for (const a of KEY_ACTIONS) {
      // "find" is the one documented exception: it has no global handler and
      // falls through to xterm's own key handler in TerminalPane, where the
      // focused pane is known.
      if (a.fn === "openFind") continue;
      expect(block, `${a.id} → ${a.fn} is not wired in TerminalsTab`).toMatch(
        new RegExp(`(^|[\\s{,])${a.fn}\\s*[:,]`, "m")
      );
    }
  });
});
