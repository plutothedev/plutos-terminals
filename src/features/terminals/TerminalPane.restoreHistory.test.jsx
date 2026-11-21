// (C)
// @vitest-environment happy-dom
//
// Restored history must survive the restored tab's own clear. The REAL
// TerminalPane on the REAL xterm (only the addons, the Tauri bridge, the
// keychain wait and two lazy modals are stubbed), because the loss lives in
// xterm itself: ED2 (ESC[2J) resets the visible rows and does not push them to
// scrollback (xterm InputHandler.eraseInDisplay, case 2). The saved file is raw
// ConPTY output, which paints with absolute cursor moves and scrolls only once
// a screen is full, so a short session replays entirely into the visible rows.
// A restored local shell then runs `marker; ESC[2J ESC[H` to hide its echoed
// setup, and before the fix that clear erased the whole history of any tab
// whose history was shorter than one screen (live check v0.7.6 row 8; present
// at v0.7.5 too).
//
// The shell is not run here: the test plays the bytes the restored display
// line prints (boot marker, ESC[2J ESC[H, a prompt) on the pane's pty event,
// after asserting which display line the pane typed (PowerShell or POSIX).
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ saved: "", listeners: new Map(), calls: [] }));
vi.mock("@backend", () => ({
  invoke: async (cmd, args) => {
    h.calls.push([cmd, args]);
    if (cmd === "scrollback_load") return h.saved;
    if (cmd === "pty_spawn") return "pty-1";
    return null;
  },
  listen: async (ev, cb) => {
    h.listeners.set(ev, cb);
    return () => {};
  },
  isTauri: () => true,
}));
// The launch keychain read never settles here; a restored local shell would
// otherwise wait its full 2 s bound before spawning.
vi.mock("./secretVault.js", async (importOriginal) => ({
  ...(await importOriginal()),
  keysReady: async () => {},
  keysSettled: () => true,
}));
// Real xterm calls activate() on every addon it loads.
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate() {} dispose() {} fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { activate() {} dispose() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { activate() {} dispose() {} clearDecorations() {} } }));
vi.mock("./ErrorExplainer.jsx", () => ({ default: () => null }));
vi.mock("./ShareModal.jsx", () => ({ default: () => null }));

import TerminalPane from "./TerminalPane.jsx";
import { getEntry, destroyAll } from "./paneRegistry.js";

const PANE = "pane-restore-history";
const RESTORED_LINE = "─── scrollback restored ───";
const PROMPT = "PS C:\\> ";
const BOOT_MARKER = "\x1b]1337;PlutoBoot=1\x07";
// What the restored display line prints, on either shell.
const SHELL_CLEAR = `${BOOT_MARKER}\x1b[2J\x1b[H${PROMPT}`;

function props(over = {}) {
  return {
    visible: false,
    active: false,
    cwd: null,
    connection: null,
    serial: null,
    startCommands: [],
    systemPrompt: "",
    agentSession: null,
    onAgentSession: () => {},
    paneLabel: "label",
    xtermTheme: {},
    tabId: PANE,
    projectName: null,
    autoApprove: false,
    onCostUpdate: () => {},
    ...over,
  };
}

// ConPTY's output for a session that never filled its screen: a clear, then
// every line placed by an absolute cursor move. Nothing here ever scrolls.
function conptyScreen(rows) {
  return "\x1b[?9001h\x1b[?1004h\x1b[2J\x1b[m\x1b[H" +
    rows.map((l, i) => `\x1b[${i + 1};1H${l}`).join("");
}
// A session long enough to have scrolled: plain lines, newline-terminated.
function scrolledSession(n, marker) {
  let s = "";
  for (let i = 0; i < n; i++) s += `old ${i}\r\n`;
  s += `${marker}\r\n`;
  for (let i = 0; i < 60; i++) s += `tail ${i}\r\n`;
  return s;
}

const lines = (t) => {
  const b = t.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
  return out;
};
const count = (t, text) => lines(t).filter((l) => l.includes(text)).length;
const screen = (t) => lines(t).slice(t.buffer.active.baseY, t.buffer.active.baseY + t.rows);
// xterm parses writes asynchronously, in order; an empty write's callback runs
// after everything queued before it.
const parsed = (t) => new Promise((r) => t.write("", r));
const wait = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
// Blank lines between the restored marker line and the shell's fresh prompt.
function gapBeforePrompt(t) {
  const all = lines(t);
  const from = all.findIndex((l) => l.includes(RESTORED_LINE));
  const to = all.findIndex((l, i) => i > from && l.startsWith(PROMPT.trimEnd()));
  return all.slice(from + 1, to).filter((l) => l.trim() === "").length;
}

let savedUa;
function setUserAgent(value) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => value });
}

beforeEach(() => {
  h.calls.length = 0;
  h.listeners.clear();
  savedUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  destroyAll();
  vi.unstubAllGlobals();
  if (savedUa) Object.defineProperty(navigator, "userAgent", savedUa);
  else delete navigator.userAgent;
});

function reset() {
  cleanup();
  destroyAll();
  h.calls.length = 0;
  h.listeners.clear();
}

// Mounts a restored pane, lets it spawn (at mount when visible, by the boot
// trickle's startSpawn when hidden), waits for the display line to be typed,
// then plays the shell's answer. `beforeClear` runs between the replay and the
// shell's clear (the 450 ms setup window).
async function restoreAndClear({ saved, visible, beforeClear }) {
  h.saved = saved;
  const view = render(<TerminalPane {...props({ visible, active: visible })} />);
  await wait(0);
  const entry = getEntry(PANE);
  if (!visible) {
    expect(entry.spawnState).toBe("unspawned");
    await act(async () => { entry.startSpawn(); }); // what trickleTick does
  }
  const term = entry.term;
  await wait(20);
  await parsed(term);
  if (beforeClear) await beforeClear(term);
  // The display line is the last setup write; it goes out after a 450 ms wait.
  const typed = () => h.calls.filter(([c, a]) => c === "pty_write" && a.data.includes("PlutoBoot"));
  for (let i = 0; i < 40 && typed().length === 0; i++) await wait(25);
  expect(typed()).toHaveLength(1);
  act(() => h.listeners.get("pty://pty-1")({ payload: SHELL_CLEAR }));
  await parsed(term);
  return { view, term, displayLine: typed()[0][1].data };
}

describe("restored history survives the restored tab's clear", () => {
  test("hidden pane started by the boot trickle, history shorter than one screen, then revealed", async () => {
    const { view, term } = await restoreAndClear({
      saved: conptyScreen([`${PROMPT}echo R7-BGTAB`, "R7-BGTAB", PROMPT]),
      visible: false,
    });
    expect(count(term, "R7-BGTAB")).toBe(2);
    expect(count(term, RESTORED_LINE)).toBe(1);
    view.rerender(<TerminalPane {...props({ visible: true, active: true })} />);
    await wait(50);
    term.resize(100, 48); // what the first fit does on reveal
    await parsed(term);
    expect(getEntry(PANE).term).toBe(term);
    expect(count(term, "R7-BGTAB")).toBe(2);
    expect(count(term, RESTORED_LINE)).toBe(1);
  });

  test("visible pane, history shorter than one screen", async () => {
    const { term } = await restoreAndClear({
      saved: conptyScreen([`${PROMPT}echo R8-VISIBLE`, "R8-VISIBLE", PROMPT]),
      visible: true,
    });
    expect(count(term, "R8-VISIBLE")).toBe(2);
    expect(count(term, RESTORED_LINE)).toBe(1);
  });

  test("history exactly one screen tall keeps its first and last rows", async () => {
    const rows = Array.from({ length: 24 }, (_, i) => `row ${i}`);
    rows[0] = "FIRST-ROW";
    rows[23] = "LAST-ROW";
    const { term } = await restoreAndClear({ saved: conptyScreen(rows), visible: false });
    expect(term.rows).toBe(24);
    expect(count(term, "FIRST-ROW")).toBe(1);
    expect(count(term, "LAST-ROW")).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
  });

  test("a hidden pane revealed (taller) between the replay and the shell's clear keeps its history", async () => {
    const { term } = await restoreAndClear({
      saved: conptyScreen([`${PROMPT}echo R9-EARLY`, "R9-EARLY", PROMPT]),
      visible: false,
      // A taller terminal pulls the newest scrollback lines back on screen
      // (xterm Buffer.resize), where the clear would reach them again.
      beforeClear: async (t) => { t.resize(100, 48); await parsed(t); },
    });
    expect(count(term, "R9-EARLY")).toBe(2);
    expect(count(term, RESTORED_LINE)).toBe(1);
  });

  test("a history longer than one screen is kept once, nothing duplicated", async () => {
    const { term } = await restoreAndClear({ saved: scrolledSession(200, "R5-LONG"), visible: false });
    expect(count(term, "R5-LONG")).toBe(1);
    expect(count(term, "old 0")).toBe(1);
    expect(count(term, "tail 59")).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
  });

  test("after the clear the screen holds only the fresh prompt", async () => {
    for (const saved of [conptyScreen([`${PROMPT}echo R7`, "R7", PROMPT]), scrolledSession(200, "R5")]) {
      reset();
      const { term } = await restoreAndClear({ saved, visible: false });
      const shown = screen(term);
      expect(shown[0].trimEnd()).toBe(PROMPT.trimEnd());
      expect(shown.slice(1).every((l) => l.trim() === "")).toBe(true);
    }
  });

  test("no blank line between the history and the new prompt", async () => {
    for (const saved of [conptyScreen([`${PROMPT}echo R7`, "R7", PROMPT]), scrolledSession(200, "R5")]) {
      reset();
      const { term } = await restoreAndClear({ saved, visible: false });
      expect(count(term, RESTORED_LINE)).toBe(1);
      // rows - 1 line feeds from the cursor row scroll out exactly the rows
      // above it, so the fresh prompt follows the marker line directly.
      expect(gapBeforePrompt(term)).toBe(0);
    }
  });

  test("both display lines (PowerShell and POSIX) end in the same clear, and both keep the history", async () => {
    const cases = [
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "[Console]::Write([char]27 + '[2J' + [char]27 + '[H')"],
      ["Mozilla/5.0 (X11; Linux x86_64)", "printf '\\033[2J\\033[H'"],
    ];
    for (const [agent, clearCmd] of cases) {
      reset();
      setUserAgent(agent);
      const { term, displayLine } = await restoreAndClear({
        saved: conptyScreen([`${PROMPT}echo R10-SHELL`, "R10-SHELL", PROMPT]),
        visible: false,
      });
      expect(displayLine).toContain(clearCmd);
      expect(count(term, "R10-SHELL")).toBe(2);
    }
  });
});
