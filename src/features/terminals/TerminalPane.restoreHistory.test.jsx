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
    if (cmd === "pty_spawn" || cmd === "ssh_spawn") return "pty-1";
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
  // The shell is spawned only once the replay has been parsed, so the spawn
  // call is the signal that the replay is done (a fixed wait would race it).
  const spawnedYet = () => h.calls.some(([c]) => c === "pty_spawn");
  for (let i = 0; i < 80 && !spawnedYet(); i++) await wait(25);
  expect(spawnedYet()).toBe(true);
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
      // The replay ends by moving every used row, then the marker line, into
      // scrollback, so the fresh prompt follows the marker line directly.
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

// ── v0.7.7: every session boundary, and every way the new shell can start ────
//
// The saved file is every past session back to back. From v0.7.7 the Rust
// reader writes a session mark at the start of each local session, and the
// loader drops the boot noise that followed it. These tests feed the pane what
// the loader returns and play what the shell (or ConPTY) prints next.
const E = String.fromCharCode(27);
const SESSION_MARK = `${E}]1337;PlutoSession=1${String.fromCharCode(7)}`;
// ConPTY's first frame, read from a real saved file: hide cursor, clear,
// reset colours, home, one line feed per row, home again.
const conptyFirstFrame = (rows = 24) => `${E}[?25l${E}[2J${E}[m${E}[H${"\r\n".repeat(rows - 1)}${E}[H`;
// One past session as the loader returns it: its clear, then its screen.
const pastSession = (tag) => `${E}[2J${E}[H` +
  [`${PROMPT}echo ${tag}`, tag, PROMPT].map((l, i) => `${E}[${i + 1};1H${l}`).join("");
const exact = (t, text) => lines(t).filter((l) => l === text).length;
const fire = (payload) => act(() => h.listeners.get("pty://pty-1")({ payload }));

// Mounts a restored pane and waits until its pty listener is attached and the
// replay is parsed. Does not play the shell's answer.
async function mountRestored({ saved, over = {} }) {
  h.saved = saved;
  const view = render(<TerminalPane {...props({ visible: true, active: true, ...over })} />);
  await wait(0);
  const entry = getEntry(PANE);
  for (let i = 0; i < 80 && !h.listeners.has("pty://pty-1"); i++) await wait(25);
  expect(h.listeners.has("pty://pty-1")).toBe(true);
  await parsed(entry.term);
  return { view, term: entry.term, entry };
}
const displayLineTyped = async () => {
  const typed = () => h.calls.filter(([c, a]) => c === "pty_write" && a.data.includes("PlutoBoot"));
  for (let i = 0; i < 60 && typed().length === 0; i++) await wait(25);
  expect(typed()).toHaveLength(1);
};

describe("restored history across several restarts", () => {
  test("three sessions in one file: every session's last screen is still there", async () => {
    const saved = pastSession("S1-OUT") + SESSION_MARK + pastSession("S2-OUT") + SESSION_MARK + pastSession("S3-OUT");
    const { term } = await restoreAndClear({ saved, visible: true });
    for (const tag of ["S1-OUT", "S2-OUT", "S3-OUT"]) {
      expect(exact(term, tag)).toBe(1);
      expect(exact(term, `${PROMPT}echo ${tag}`)).toBe(1);
    }
    const order = ["S1-OUT", "S2-OUT", "S3-OUT", RESTORED_LINE].map((s) => lines(term).findIndex((l) => l.includes(s)));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(count(term, RESTORED_LINE)).toBe(1);
    const shown = screen(term);
    expect(shown[0].trimEnd()).toBe(PROMPT.trimEnd());
    expect(shown.slice(1).every((l) => l.trim() === "")).toBe(true);
  });

  test("the same holds when the boot noise was not dropped (each session opens with ConPTY's first frame)", async () => {
    const noisy = (tag) => conptyFirstFrame() + "banner + echoed setup" + BOOT_MARKER + pastSession(tag);
    const saved = pastSession("S1-OUT") + SESSION_MARK + noisy("S2-OUT") + SESSION_MARK + noisy("S3-OUT");
    const { term } = await restoreAndClear({ saved, visible: false });
    for (const tag of ["S1-OUT", "S2-OUT", "S3-OUT"]) expect(exact(term, tag)).toBe(1);
  });

  test("three sessions, then the pane is revealed taller before the shell answers: nothing comes back on screen, nothing is lost", async () => {
    const saved = pastSession("S1-OUT") + SESSION_MARK + pastSession("S2-OUT") + SESSION_MARK + pastSession("S3-OUT");
    const { term } = await restoreAndClear({
      saved,
      visible: false,
      beforeClear: async (t) => {
        t.resize(100, 48);
        await parsed(t);
        // The whole history is already in scrollback and stays there.
        expect(screen(t).every((l) => l.trim() === "")).toBe(true);
      },
    });
    for (const tag of ["S1-OUT", "S2-OUT", "S3-OUT"]) expect(exact(term, tag)).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
    expect(gapBeforePrompt(term)).toBe(0);
  });

  test("a file holding only session marks is a fresh pane: no restored line, and the fresh display line", async () => {
    h.saved = SESSION_MARK + SESSION_MARK;
    render(<TerminalPane {...props({ visible: true, active: true })} />);
    await wait(0);
    const term = getEntry(PANE).term;
    await displayLineTyped();
    const typed = h.calls.filter(([c, a]) => c === "pty_write" && a.data.includes("PlutoBoot"))[0][1].data;
    expect(typed).not.toContain("'[2J'"); // the restored variant
    expect(typed).not.toContain("033[2J");
    await parsed(term);
    expect(count(term, RESTORED_LINE)).toBe(0);
  });

  test("a file that starts with a session mark restores like one that does not", async () => {
    const { term } = await restoreAndClear({ saved: SESSION_MARK + pastSession("ONLY-OUT"), visible: true });
    expect(exact(term, "ONLY-OUT")).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
    expect(gapBeforePrompt(term)).toBe(0);
  });
});

describe("the new shell's start cannot erase restored history", () => {
  test("cursor parked above the last used row: the rows below it survive and no gap is added", async () => {
    const saved = conptyScreen(["top", "middle", "LOWEST-ROW"]) + `${E}[1;1H`;
    const { term } = await restoreAndClear({ saved, visible: true });
    expect(exact(term, "LOWEST-ROW")).toBe(1);
    expect(exact(term, "top")).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
    expect(gapBeforePrompt(term)).toBe(0);
    // The restored line sits below the history, not on top of it.
    const all = lines(term);
    expect(all.findIndex((l) => l.includes(RESTORED_LINE))).toBeGreaterThan(all.indexOf("LOWEST-ROW"));
  });

  test("a history that ended inside a pager: the new prompt lands on the normal screen", async () => {
    const saved = conptyScreen([`${PROMPT}less notes.txt`, "SHELL-LINE"]) + `${E}[?1049h${E}[2J${E}[HPAGER-TEXT`;
    const { term } = await restoreAndClear({ saved, visible: true });
    expect(term.buffer.active.type).toBe("normal");
    expect(exact(term, "SHELL-LINE")).toBe(1);
    expect(screen(term)[0].trimEnd()).toBe(PROMPT.trimEnd());
    expect(count(term, "PAGER-TEXT")).toBe(0);
  });

  test("a cursor shape left by an editor is back to the pane's own before the shell starts", async () => {
    const saved = conptyScreen([`${PROMPT}vim notes.txt`, "EDITOR-RAN"]) + `${E}[2 q`;
    const { term } = await restoreAndClear({ saved, visible: true });
    expect(term.options.cursorStyle).toBe("bar");
    expect(term.options.cursorBlink).toBe(true);
    expect(exact(term, "EDITOR-RAN")).toBe(1);
  });

  test("boot marker split across two pty events", async () => {
    const { term } = await mountRestored({ saved: conptyScreen([`${PROMPT}echo SPLIT`, "SPLIT-OUT", PROMPT]) });
    await displayLineTyped();
    fire("banner noise" + BOOT_MARKER.slice(0, 9));
    fire(BOOT_MARKER.slice(9) + `${E}[2J${E}[H${PROMPT}`);
    await parsed(term);
    await parsed(term);
    expect(exact(term, "SPLIT-OUT")).toBe(1);
    expect(count(term, "banner noise")).toBe(0);
    expect(screen(term)[0].trimEnd()).toBe(PROMPT.trimEnd());
  });

  test("output that follows the marker in the same tick is rendered in order", async () => {
    const { term } = await mountRestored({ saved: conptyScreen([`${PROMPT}echo ORDER`, "ORDER-OUT", PROMPT]) });
    await displayLineTyped();
    // Same tick: the marker chunk, then two more chunks before xterm has
    // parsed anything.
    act(() => {
      const cb = h.listeners.get("pty://pty-1");
      cb({ payload: `${BOOT_MARKER}${E}[2J${E}[H${PROMPT}first` });
      cb({ payload: " second" });
      cb({ payload: "\r\nNEXT-LINE" });
    });
    await parsed(term);
    await parsed(term);
    await parsed(term);
    expect(exact(term, "ORDER-OUT")).toBe(1);
    const shown = screen(term);
    expect(shown[0]).toBe(`${PROMPT}first second`);
    expect(shown[1]).toBe("NEXT-LINE");
  });

  test("a slow shell whose banner fills the screen, then a taller reveal, then the late marker (split in two): history survives the clear", async () => {
    let hist = "";
    for (let i = 0; i < 30; i++) hist += `hist ${i}\r\n`;
    const { term } = await mountRestored({ saved: hist });
    await displayLineTyped();
    // 24 rows of banner and echoed setup, held by the gate.
    fire(Array.from({ length: 24 }, (_, i) => `slow banner ${i}`).join("\r\n"));
    await wait(4300); // past the 4 s fallback: the gate gives up and shows what it held
    await parsed(term);
    expect(count(term, "slow banner 23")).toBe(1);
    // The banner filled the screen, so the cursor is on the last row: a taller
    // terminal now pulls the newest history rows back on screen.
    term.resize(80, 45);
    await parsed(term);
    expect(screen(term).some((l) => l.includes(RESTORED_LINE))).toBe(true);
    fire(BOOT_MARKER.slice(0, 11));
    fire(BOOT_MARKER.slice(11) + `${E}[2J${E}[H${PROMPT}`);
    await parsed(term);
    for (let i = 0; i < 30; i++) expect(exact(term, `hist ${i}`)).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
    expect(screen(term)[0].trimEnd()).toBe(PROMPT.trimEnd());
  }, 15000);

  test("a restored pane with start commands (no boot gate): ConPTY's first frame does not erase the last screen", async () => {
    const { term } = await mountRestored({
      saved: conptyScreen([`${PROMPT}run-agent`, "AGENT-LAST-SCREEN", "more agent output"]),
      over: { startCommands: ["echo started"] },
    });
    fire(conptyFirstFrame() + `${PROMPT}`);
    await parsed(term);
    await parsed(term);
    expect(exact(term, "AGENT-LAST-SCREEN")).toBe(1);
    expect(exact(term, "more agent output")).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
    expect(screen(term)[0].trimEnd()).toBe(PROMPT.trimEnd());
  });

  test("a fresh pane (nothing saved) is never sealed", async () => {
    h.saved = null;
    render(<TerminalPane {...props({ visible: true, active: true })} />);
    await wait(0);
    const entry = getEntry(PANE);
    const writes = [];
    const realWrite = entry.term.write.bind(entry.term);
    entry.term.write = (data, cb) => { writes.push(String(data)); return realWrite(data, cb); };
    await displayLineTyped();
    fire(`banner${BOOT_MARKER}${E}[2J${E}[HWELCOME\r\n${PROMPT}`);
    await parsed(entry.term);
    expect(writes.some((w) => w.includes("WELCOME"))).toBe(true); // the spy sees the pane's writes
    expect(writes.some((w) => w.includes("?1049l"))).toBe(false);
    expect(entry.term.buffer.active.baseY).toBe(0);
    expect(count(entry.term, RESTORED_LINE)).toBe(0);
  });

  test("a restored SSH pane replays exactly as before: one write, no seal", async () => {
    const saved = conptyScreen(["remote line 1", "remote line 2"]) + SESSION_MARK + "after a mark";
    const { term } = await mountRestored({
      saved,
      over: { connection: { host: "example.invalid", user: "u", port: 22, auth: { method: "agent" } } },
    });
    fire("Last login: today\r\n");
    await parsed(term);
    // Not pushed into scrollback, not reset, not split at the mark.
    expect(term.buffer.active.baseY).toBe(0);
    expect(exact(term, "remote line 1")).toBe(1);
    expect(count(term, "after a mark")).toBe(1);
    expect(count(term, RESTORED_LINE)).toBe(1);
  });
});

describe("the shell starts only when the replay is done, and only for a pane that still exists", () => {
  const spawned = () => h.calls.some(([c]) => c === "pty_spawn");
  // Mounts a hidden restored pane and holds every write to its terminal, so
  // the replay cannot finish until `release` is called.
  async function mountHeld(saved) {
    h.saved = saved;
    const view = render(<TerminalPane {...props({ visible: false, active: false })} />);
    await wait(0);
    const entry = getEntry(PANE);
    const term = entry.term;
    const real = term.write.bind(term);
    const held = [];
    term.write = (data, cb) => { held.push([data, cb]); };
    const release = () => {
      term.write = real;
      for (const [data, cb] of held.splice(0)) {
        try { real(data, cb); } catch { if (cb) cb(); }
      }
    };
    await act(async () => { entry.startSpawn(); });
    return { view, entry, term, release };
  }

  test("no shell is spawned while the replay is still being parsed", async () => {
    const { term, release } = await mountHeld(pastSession("S1-OUT") + SESSION_MARK + pastSession("S2-OUT"));
    await wait(200);
    expect(spawned()).toBe(false);
    release();
    for (let i = 0; i < 80 && !spawned(); i++) await wait(25);
    expect(spawned()).toBe(true);
    await parsed(term);
    // The spawn came after the whole replay: the end line is already there.
    expect(count(term, RESTORED_LINE)).toBe(1);
    expect(exact(term, "S1-OUT")).toBe(1);
  });

  test("a pane destroyed during the replay never spawns a shell", async () => {
    const { view, release } = await mountHeld(pastSession("S1-OUT") + SESSION_MARK + pastSession("S2-OUT"));
    view.unmount();
    destroyAll();
    release();
    await wait(300);
    expect(spawned()).toBe(false);
  });
});

describe("what the loader is asked for", () => {
  const loadArgs = () => h.calls.find(([c]) => c === "scrollback_load")[1];

  test("a local pane says so, so the loader may drop boot noise at session marks", async () => {
    await mountRestored({ saved: conptyScreen(["x"]) });
    expect(loadArgs()).toEqual({ tabId: PANE, local: true });
  });

  test("an SSH pane says it is not local: its saved file is returned as it is", async () => {
    await mountRestored({
      saved: conptyScreen(["x"]),
      over: { connection: { host: "example.invalid", user: "u", port: 22, auth: { method: "agent" } } },
    });
    expect(loadArgs()).toEqual({ tabId: PANE, local: false });
  });
});
