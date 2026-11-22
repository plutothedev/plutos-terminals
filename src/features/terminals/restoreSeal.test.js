// (C)
// @vitest-environment happy-dom
//
// The seal that runs at every session boundary of a restored history, on the
// REAL xterm: the loss it prevents lives in xterm itself (ED2 blanks the
// visible rows without moving them into scrollback), so a stubbed terminal
// would prove nothing.
import { describe, test, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SESSION_SENTINEL, sealScreen, lastUsedRow, replaySaved, pushBackHistory } from "./restoreSeal.js";

const ESC = String.fromCharCode(27);
const CSI = ESC + "[";
const ST = ESC + String.fromCharCode(92);
const CLEAR_HOME = CSI + "2J" + CSI + "H";

const make = (rows = 24, cols = 80) => new Terminal({
  rows, cols, scrollback: 1000, allowProposedApi: true, cursorBlink: true, cursorStyle: "bar",
});
const write = (t, s) => new Promise((r) => t.write(s, r));
const seal = (t) => new Promise((r) => sealScreen(t, r));
const all = (t) => {
  const b = t.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
  return out;
};
const viewport = (t) => {
  const b = t.buffer.active;
  return all(t).slice(b.baseY, b.baseY + t.rows);
};
const history = (t) => all(t).slice(0, t.buffer.active.baseY);
const count = (t, text) => all(t).filter((l) => l.includes(text)).length;
const blankScreen = (t) => viewport(t).every((l) => l === "");
// A screen painted the way ConPTY paints one: a clear, then every line placed
// by an absolute cursor move. Nothing here scrolls.
const painted = (lines) => CLEAR_HOME + lines.map((l, i) => `${CSI}${i + 1};1H${l}`).join("");

describe("sealScreen", () => {
  test("moves exactly the used rows into scrollback and homes the cursor", async () => {
    const t = make();
    await write(t, painted(["one", "two", "three"]));
    await seal(t);
    expect(history(t)).toEqual(["one", "two", "three"]);
    expect(blankScreen(t)).toBe(true);
    expect(t.buffer.active.cursorX).toBe(0);
    expect(t.buffer.active.cursorY).toBe(0);
  });

  test("cursor parked above the last used row: the rows below it are kept", async () => {
    const t = make();
    await write(t, painted(["one", "two", "three", "four", "five"]) + `${CSI}2;1H`);
    expect(t.buffer.active.cursorY).toBe(1);
    expect(lastUsedRow(t)).toBe(4);
    await seal(t);
    expect(history(t)).toEqual(["one", "two", "three", "four", "five"]);
  });

  test("cursor parked below the last used row: no blank line is added", async () => {
    const t = make();
    await write(t, painted(["one", "two"]) + `${CSI}20;1H`);
    await seal(t);
    expect(history(t)).toEqual(["one", "two"]);
  });

  test("rows that hold only written spaces count as blank", async () => {
    const t = make();
    await write(t, painted(["one", "   ", "     "]));
    await seal(t);
    expect(t.buffer.active.baseY).toBe(1);
  });

  test("an empty screen pushes nothing", async () => {
    const t = make();
    await seal(t);
    expect(t.buffer.active.baseY).toBe(0);
    expect(blankScreen(t)).toBe(true);
  });

  test("a full screen keeps its first and last rows", async () => {
    const t = make();
    const rows = Array.from({ length: 24 }, (_, i) => `row ${i}`);
    await write(t, painted(rows));
    await seal(t);
    expect(history(t)).toEqual(rows);
  });

  test("a history that ended in the alternate screen comes back to the normal one", async () => {
    const t = make();
    await write(t, painted(["shell line", "$ less file"]) + `${CSI}?1049h` + painted(["PAGER TEXT"]));
    expect(t.buffer.active.type).toBe("alternate");
    await seal(t);
    expect(t.buffer.active.type).toBe("normal");
    expect(history(t)).toEqual(["shell line", "$ less file"]);
    expect(count(t, "PAGER TEXT")).toBe(0);
    await write(t, CLEAR_HOME + "PS> ");
    expect(viewport(t)[0]).toBe("PS> ");
    expect(count(t, "shell line")).toBe(1);
  });

  test("a scroll region left set no longer traps new output", async () => {
    const t = make();
    await write(t, painted(["kept"]) + `${CSI}5;10r`);
    await seal(t);
    let out = "";
    for (let i = 0; i < 40; i++) out += `line ${i}\r\n`;
    await write(t, out);
    const lines = all(t);
    // With the region still set, 40 lines would overwrite each other inside
    // rows 5 to 10 and most of them would be gone.
    for (let i = 0; i < 40; i++) expect(lines.filter((l) => l === `line ${i}`)).toHaveLength(1);
    expect(lines.filter((l) => l === "kept")).toHaveLength(1);
  });

  test("a half-finished escape sequence is dropped, not acted on, and swallows nothing", async () => {
    const t = make();
    const titles = [];
    t.onTitleChange((title) => titles.push(title));
    await write(t, "before" + ESC + "]0;HALF-A-TITLE");
    await seal(t);
    await write(t, "PROMPT");
    expect(titles).toEqual([]); // ESC alone would have ended the title sequence as if complete
    expect(viewport(t)[0]).toBe("PROMPT");
    expect(history(t)).toEqual(["before"]);
  });

  test("colours, mouse reporting, bracketed paste and key modes are back to defaults", async () => {
    const t = make();
    await write(t, `${CSI}31m${CSI}?1000h${CSI}?1006h${CSI}?2004h${CSI}?1h${CSI}?6h${CSI}?7l${CSI}4h${CSI}?25l` + "red");
    // The history really did leave these set (so the asserts below can fail).
    expect(t.modes.mouseTrackingMode).not.toBe("none");
    expect(t.modes.bracketedPasteMode).toBe(true);
    expect(t.modes.applicationCursorKeysMode).toBe(true);
    expect(t.modes.originMode).toBe(true);
    expect(t.modes.wraparoundMode).toBe(false);
    expect(t.modes.insertMode).toBe(true);
    await seal(t);
    expect(t.modes.mouseTrackingMode).toBe("none");
    expect(t.modes.bracketedPasteMode).toBe(false);
    expect(t.modes.applicationCursorKeysMode).toBe(false);
    expect(t.modes.originMode).toBe(false);
    expect(t.modes.wraparoundMode).toBe(true);
    expect(t.modes.insertMode).toBe(false);
    await write(t, "x");
    const cell = t.buffer.active.getLine(t.buffer.active.baseY).getCell(0);
    expect(cell.getChars()).toBe("x");
    expect(cell.isFgDefault()).toBe(true);
  });

  test("the cursor shape an editor set, line-feed mode and an open hyperlink do not leak into the new shell", async () => {
    const t = make();
    await write(t, `${CSI}2 q${CSI}20h${ESC}]8;;https://example.invalid/${ST}linked text`);
    expect(t.options.cursorStyle).toBe("block");
    expect(t.options.cursorBlink).toBe(false);
    expect(t.options.convertEol).toBe(true);
    // No public API reads the hyperlink a new cell would get.
    const linkId = () => t._core._inputHandler._curAttrData.extended.urlId;
    expect(linkId()).not.toBe(0);
    await seal(t);
    expect(t.options.cursorStyle).toBe("bar");
    expect(t.options.cursorBlink).toBe(true);
    expect(t.options.convertEol).toBe(false);
    expect(linkId()).toBe(0);
  });

  test("a red cursor state the dead program had saved does not colour the new shell", async () => {
    const t = make();
    // DECSC with red set: leaving the alternate screen restores the saved
    // cursor, attributes included, so the reset must clear them after that.
    await write(t, `${CSI}31m${ESC}7`);
    await seal(t);
    await write(t, "x");
    const cell = t.buffer.active.getLine(t.buffer.active.baseY).getCell(0);
    expect(cell.getChars()).toBe("x");
    expect(cell.isFgDefault()).toBe(true);
  });

  test("cursor visibility, mouse encoding, focus reports and keypad mode are back to defaults", async () => {
    const t = make();
    await write(t, `${CSI}?25l${CSI}?1000h${CSI}?1006h${CSI}?1004h${ESC}=`);
    // No public API reads these two.
    const hidden = () => t._core.coreService.isCursorHidden;
    const encoding = () => t._core.coreMouseService.activeEncoding;
    expect(hidden()).toBe(true);
    expect(encoding()).toBe("SGR");
    expect(t.modes.sendFocusMode).toBe(true);
    expect(t.modes.applicationKeypadMode).toBe(true);
    await seal(t);
    expect(hidden()).toBe(false);
    expect(encoding()).toBe("DEFAULT");
    expect(t.modes.sendFocusMode).toBe(false);
    expect(t.modes.applicationKeypadMode).toBe(false);
  });

  test("line-drawing character sets left selected do not turn the new shell's text into box lines", async () => {
    const SO = String.fromCharCode(14);
    // G0 and G1 both set to line drawing, G1 shifted in.
    const t = make();
    await write(t, `${ESC}(0${ESC})0${SO}q`);
    expect(viewport(t)[0]).not.toBe("q"); // really was line drawing
    await seal(t);
    await write(t, "q");
    expect(viewport(t)[0]).toBe("q"); // G0 is ASCII again
    await write(t, `${SO}q`);
    expect(viewport(t)[0]).toBe("qq"); // and so is G1
    // G0 is the selected set again: a shell that later loads line drawing
    // into G1 (a common terminal init) must not have its text use it.
    const u = make();
    await write(u, SO);
    await seal(u);
    await write(u, `${ESC})0q`);
    expect(viewport(u)[0]).toBe("q");
  });

  test("scrollback that was already there is not erased", async () => {
    const t = make();
    let out = "";
    for (let i = 0; i < 100; i++) out += `old ${i}\r\n`;
    await write(t, out);
    await seal(t);
    expect(all(t).filter((l) => l === "old 99")).toHaveLength(1);
    expect(all(t).filter((l) => l === "old 0")).toHaveLength(1);
    expect(blankScreen(t)).toBe(true);
  });

  test("the terminal growing between the measure and the push loses nothing", async () => {
    const t = make(10);
    const rows = Array.from({ length: 10 }, (_, i) => `row ${i}`);
    await write(t, painted(rows));
    const sealed = seal(t);
    // Queued behind the seal's measuring write, so it runs after the rows were
    // counted and before the seal itself is parsed.
    t.write("", () => t.resize(80, 24));
    await sealed;
    expect(history(t)).toEqual(rows);
    expect(blankScreen(t)).toBe(true);
  });

  test("with scrollback above: a taller terminal between the measure and the push pulls rows back down, and they are sealed too", async () => {
    const t = make();
    let out = "";
    for (let i = 0; i < 60; i++) out += `line ${i}\r\n`;
    await write(t, out.trimEnd());
    const sealed = seal(t);
    t.write("", () => t.resize(80, 45)); // after the measure, before the push is parsed
    await sealed;
    expect(blankScreen(t)).toBe(true);
    await write(t, CLEAR_HOME + "PS> ");
    for (let i = 0; i < 60; i++) expect(all(t).filter((l) => l === `line ${i}`)).toHaveLength(1);
  });

  test("a throw inside the measuring callback does not escape into the terminal's write loop", async () => {
    // xterm runs write callbacks later, from its own loop, with no protection:
    // a throw there stops the terminal parsing. This stand-in calls back the
    // same way (later), so an unguarded throw would surface as an unhandled
    // error and `done` would never run.
    const broken = {
      rows: 24,
      write(_data, cb) { if (cb) queueMicrotask(cb); },
      get buffer() { throw new Error("disposed"); },
    };
    await new Promise((done) => sealScreen(broken, done));
  });

  test("a terminal that throws when measured still calls back", async () => {
    let calls = 0;
    const broken = {
      rows: 24,
      write(_data, cb) { if (cb) cb(); },
      get buffer() { throw new Error("disposed"); },
    };
    expect(() => sealScreen(broken, () => { calls++; })).not.toThrow();
    expect(calls).toBe(1);
  });

  test("after a seal, a taller terminal does not bring history back on screen", async () => {
    const t = make();
    await write(t, painted(["one", "two", "three"]));
    await seal(t);
    t.resize(100, 48);
    await write(t, "");
    expect(blankScreen(t)).toBe(true);
    await write(t, CLEAR_HOME + "PS> ");
    expect(history(t)).toEqual(["one", "two", "three"]);
  });
});

describe("replaySaved", () => {
  // Sessions back to back, each starting with the clear ConPTY sends as its
  // first frame. Without a seal at each boundary every clear erases the screen
  // before it.
  const session = (tag) => painted([`PS> echo ${tag}`, tag, "PS> "]);
  const END = "--- restored ---";

  test("every session's last screen survives the next session's first clear", async () => {
    const t = make();
    const ok = await replaySaved(t, session("S1") + SESSION_SENTINEL + session("S2") + SESSION_SENTINEL + session("S3"), () => true, END);
    expect(ok).toBe(true);
    expect(history(t)).toEqual([
      "PS> echo S1", "S1", "PS> ",
      "PS> echo S2", "S2", "PS> ",
      "PS> echo S3", "S3", "PS> ",
      END,
    ]);
    expect(blankScreen(t)).toBe(true);
    expect(t.buffer.active.cursorY).toBe(0);
  });

  test("the end line is the last line of the history, and the new shell's clear cannot reach it", async () => {
    const t = make();
    await replaySaved(t, session("ONLY"), () => true, END);
    await write(t, CLEAR_HOME + "PS> ");
    expect(history(t)).toEqual(["PS> echo ONLY", "ONLY", "PS> ", END]);
    expect(viewport(t)[0]).toBe("PS> ");
  });

  test("a leading session mark changes nothing", async () => {
    const a = make();
    const b = make();
    await replaySaved(a, SESSION_SENTINEL + session("ONLY"), () => true, END);
    await replaySaved(b, session("ONLY"), () => true, END);
    expect(all(a)).toEqual(all(b));
  });

  test("text with no session mark keeps every line a plain write would show", async () => {
    const a = make();
    const b = make();
    let text = "";
    for (let i = 0; i < 60; i++) text += `plain ${i}\r\n`;
    text += "tail a\r\ntail b";
    await replaySaved(a, text);
    await write(b, text);
    expect(history(a)).toEqual(all(b).filter((l) => l !== ""));
    expect(blankScreen(a)).toBe(true);
  });

  test("a session that ended in the alternate screen does not hide the next one", async () => {
    const t = make();
    await replaySaved(t, session("S1") + `${CSI}?1049h` + painted(["PAGER"]) + SESSION_SENTINEL + session("S2"));
    expect(t.buffer.active.type).toBe("normal");
    expect(history(t)).toEqual(["PS> echo S1", "S1", "PS> ", "PS> echo S2", "S2", "PS> "]);
  });

  test("nothing saved, or only session marks, is not a restore", async () => {
    const t = make();
    expect(await replaySaved(t, "", () => true, END)).toBe(false);
    expect(await replaySaved(t, SESSION_SENTINEL + SESSION_SENTINEL, () => true, END)).toBe(false);
    expect(all(t).every((l) => l === "")).toBe(true);
    expect(t.buffer.active.baseY).toBe(0);
  });

  test("stops quietly when the pane is gone", async () => {
    const t = make();
    let live = true;
    const p = replaySaved(t, session("S1") + SESSION_SENTINEL + session("S2"), () => live, END);
    live = false;
    await p;
    expect(count(t, "S2")).toBe(0);
    expect(count(t, END)).toBe(0);
  });

  test("an end line wider than the pane leaves the screen completely", async () => {
    const t = make(24, 20);
    const long = "x".repeat(45); // three rows at 20 columns
    await replaySaved(t, painted(["one"]), () => true, long);
    expect(blankScreen(t)).toBe(true);
    expect(history(t).join("")).toBe("one" + long);
  });

  test("the end line starts its own line even when the row it lands on was a wrapped continuation", async () => {
    const t = make(24, 20);
    // 20 characters fill row 0; the three spaces wrap onto row 1, which is
    // blank to the eye but flagged as a continuation of row 0.
    await replaySaved(t, "a".repeat(20) + "   ", () => true, END);
    const b = t.buffer.active;
    let at = -1;
    for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) === END) at = i;
    expect(at).toBeGreaterThan(-1);
    expect(b.getLine(at).isWrapped).toBe(false);
  });

  test("sixty sessions replay in one parsing pass, not a timer round trip per session", async () => {
    const t = make();
    let saved = "";
    for (let i = 0; i < 60; i++) saved += SESSION_SENTINEL + session(`S${i}`);
    const spy = vi.spyOn(globalThis, "setTimeout"); // counts, and still calls through
    let timers = 0;
    try {
      await replaySaved(t, saved, () => true, END);
      timers = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
    expect(timers).toBeGreaterThan(0); // the count is real: xterm did schedule its parsing pass
    // A hidden window runs timers about once a second: a round trip per
    // session would hold a pane's shell back for minutes.
    expect(timers).toBeLessThan(40); // one or two when measured; a round trip per session would be 120
    expect(count(t, "S59")).toBe(2);
    expect(count(t, "S0")).toBeGreaterThan(0);
  });

  test("a terminal that throws part-way still settles the replay", async () => {
    let writes = 0;
    const broken = {
      rows: 2,
      buffer: { normal: { baseY: 0, getLine: () => ({ translateToString: () => "" }) } },
      write(_data, cb) {
        writes += 1;
        if (writes === 3) throw new Error("disposed");
        if (cb) cb();
      },
    };
    await expect(replaySaved(broken, "a" + SESSION_SENTINEL + "b", () => true, END)).resolves.toBe(true);
  });
});

describe("pushBackHistory", () => {
  const END = "--- restored ---";
  const NOISE = Array.from({ length: 24 }, (_, i) => `noise ${i}`).join("\r\n");
  let HIST = "";
  for (let i = 0; i < 30; i++) HIST += `hist ${i}\r\n`;
  const kept = (t) => all(t).filter((l) => l.startsWith("hist ") || l === END).length;

  // A slow shell's banner fills the screen (cursor on the last row), then the
  // pane is revealed taller: xterm pulls the newest history rows back down.
  async function slowShellThenReveal() {
    const t = make();
    await replaySaved(t, HIST, () => true, END);
    const marker = t.registerMarker(-1); // the end line: last line of the history
    expect(pushBackHistory(t, marker)).toBe(""); // nothing of it on screen yet
    await write(t, NOISE);
    t.resize(80, 45);
    await write(t, "");
    return { t, marker };
  }

  test("the scenario is real: without the push, the late clear erases history", async () => {
    const { t } = await slowShellThenReveal();
    expect(viewport(t).some((l) => l === END)).toBe(true); // history is back on screen
    await write(t, CLEAR_HOME + "PS> ");
    expect(kept(t)).toBeLessThan(31);
  });

  test("history pulled back on screen is moved into scrollback again before the clear", async () => {
    const { t, marker } = await slowShellThenReveal();
    const push = pushBackHistory(t, marker);
    expect(push).not.toBe("");
    await write(t, push + CLEAR_HOME + "PS> ");
    expect(kept(t)).toBe(31);
    for (let i = 0; i < 30; i++) expect(all(t).filter((l) => l === `hist ${i}`)).toHaveLength(1);
    expect(viewport(t)[0]).toBe("PS> ");
    // Only history went up: the banner was on screen and the clear took it.
    expect(count(t, "noise 23")).toBe(0);
  });

  test("the cursor stays on the line of text it was on", async () => {
    const { t, marker } = await slowShellThenReveal();
    const under = () => {
      const buf = t.buffer.active;
      return [buf.cursorX, buf.getLine(buf.baseY + buf.cursorY).translateToString(true)];
    };
    const before = under();
    expect(before[1]).toBe("noise 23");
    await write(t, pushBackHistory(t, marker));
    // xterm restores a saved cursor onto the same buffer line, so it moved up
    // with the text instead of staying on the (now blank) last row.
    expect(under()).toEqual(before);
  });

  test("with the alternate screen showing, nothing is pushed", async () => {
    const { t, marker } = await slowShellThenReveal();
    expect(pushBackHistory(t, marker)).not.toBe("");
    await write(t, CSI + "?1049h");
    expect(pushBackHistory(t, marker)).toBe("");
  });

  test("no marker, or one whose line is gone, asks for nothing", async () => {
    const t = make();
    expect(pushBackHistory(t, null)).toBe("");
    const marker = t.registerMarker(0);
    marker.dispose();
    expect(pushBackHistory(t, marker)).toBe("");
  });
});

// ── replay at the size each part was recorded at ─────────────────────────────
//
// On Windows every resize makes ConPTY repaint its whole view, and each paint
// is in the saved file. The shapes below are the ones read from real captures
// of the app (v0.7.7 live check, 2026-11-22): a paint is "hide cursor, home,
// then exactly `rows` lines each ending in erase-to-end-of-line, CR LF between
// them, then a cursor position and show cursor". A paint recorded for a taller
// window scrolls when it is replayed into a shorter terminal, and the block
// then shows up twice. The saved stream now carries the size
// (ESC]1337;PlutoSize=<cols>;<rows> BEL) and the replay resizes to it.
describe("replaySaved at the recorded size", () => {
  const BEL = String.fromCharCode(7);
  const SIZE = (cols, rows) => `${ESC}]1337;PlutoSize=${cols};${rows}${BEL}`;
  const END = "--- restored ---";
  const CONPTY = { conpty: true }; // these streams came from ConPTY
  const WINDOWS = { windowsPty: { backend: "conpty", buildNumber: 22631 } };
  const term = (rows, cols, extra = {}) => new Terminal({
    rows, cols, scrollback: 1000, allowProposedApi: true, cursorBlink: true, cursorStyle: "bar", ...extra,
  });
  // ConPTY's repaint of a view `rows` tall whose first rows hold `lines`.
  const paint = (lines, rows) => `${CSI}?25l${CSI}H` +
    Array.from({ length: rows }, (_, i) => (lines[i] || "") + `${CSI}K`).join("\r\n") +
    `${CSI}${lines.length};3H${CSI}?25h`;
  const once = (t, wanted) => {
    const lines = all(t);
    for (const w of wanted) expect([w, lines.filter((l) => l === w).length]).toEqual([w, 1]);
  };
  const five = [1, 2, 3, 4, 5].map((i) => `OUT-${i}`);
  // A short session: five lines typed out, then the window made taller and
  // put back, twice. ConPTY repaints on each of the four resizes.
  const view = ["PS> run", ...five, "PS> "];
  const resized = SIZE(83, 36) + CLEAR_HOME + view.join("\r\n") +
    SIZE(104, 49) + paint(view, 49) + SIZE(83, 36) + paint(view, 36) +
    SIZE(104, 49) + paint(view, 49) + SIZE(83, 36) + paint(view, 36);

  test("the control: replayed at one size, a resized session repeats its lines", async () => {
    // The same bytes without the size marks, as every build before this one
    // replayed them.
    const t = term(36, 83);
    // Every BEL in this fixture ends a size mark: cut each piece at its mark.
    const noSizeMarks = resized.split(BEL).map((piece) => {
      const at = piece.indexOf(`${ESC}]1337;PlutoSize=`);
      return at < 0 ? piece : piece.slice(0, at);
    }).join("");
    expect(noSizeMarks).not.toContain("PlutoSize");
    expect(noSizeMarks).toContain("OUT-3");
    await replaySaved(t, noSizeMarks, () => true, END, CONPTY);
    expect(all(t).filter((l) => l === "OUT-3").length).toBeGreaterThan(1);
  });

  test("a resized session comes back with every line once, in a terminal of the pane's size", async () => {
    const t = term(36, 83);
    await replaySaved(t, resized, () => true, END, CONPTY);
    once(t, [...five, "PS> run", END]);
    expect(blankScreen(t)).toBe(true);
  });

  test("and in a background tab's 80 x 24 terminal", async () => {
    const t = term(24, 80);
    await replaySaved(t, resized, () => true, END, CONPTY);
    once(t, [...five, "PS> run", END]);
  });

  test("the terminal is back at its own size when the replay is done", async () => {
    const t = term(24, 80);
    await replaySaved(t, resized, () => true, END, CONPTY);
    expect([t.cols, t.rows]).toEqual([80, 24]);
    expect(blankScreen(t)).toBe(true);
    expect(t.buffer.active.cursorY).toBe(0);
  });

  test("several sessions, each resized: every line of each once", async () => {
    const session = (tag) => {
      const v = [`PS> ${tag}`, `${tag}-A`, `${tag}-B`, "PS> "];
      return SIZE(83, 36) + CLEAR_HOME + v.join("\r\n") + SIZE(104, 49) + paint(v, 49) + SIZE(83, 36) + paint(v, 36);
    };
    const t = term(24, 80);
    await replaySaved(t, SESSION_SENTINEL + session("S1") + SESSION_SENTINEL + session("S2") + SESSION_SENTINEL + session("S3"), () => true, END, CONPTY);
    once(t, ["S1-A", "S1-B", "S2-A", "S2-B", "S3-A", "S3-B", END]);
    const at = (s) => all(t).indexOf(s);
    expect(at("S1-B")).toBeLessThan(at("S2-A"));
    expect(at("S2-B")).toBeLessThan(at("S3-A"));
  });

  // A full screen, then a taller window. ConPTY keeps its text at the top and
  // adds blank rows below it (capture: 60 lines on 36 rows, repaint for 49 rows
  // = lines 26 to 60, the prompt, 13 blank rows).
  const sixty = Array.from({ length: 60 }, (_, i) => `ROW-${i + 1}`);
  const tail = [...sixty.slice(25), "PS> "]; // what a 36-row screen shows: rows 26 to 60 and the prompt
  const fullThenTaller = SIZE(83, 36) + CLEAR_HOME + sixty.join("\r\n") + "\r\nPS> " +
    SIZE(104, 49) + paint(tail, 49) + SIZE(83, 36) + paint(tail, 36);

  test("a full screen made taller: with xterm's Windows mode no row is lost at replay", async () => {
    const t = term(36, 83, WINDOWS);
    await replaySaved(t, fullThenTaller, () => true, END, CONPTY);
    once(t, [...sixty, END]);
  });

  test("the same replay on xterm's default mode: rows the taller resize pulls down are pushed back before the repaint", async () => {
    // Off Windows, or for a terminal not in ConPTY mode, xterm pulls scrollback
    // rows down on a taller resize; the recorded repaint would overwrite them.
    const t = term(36, 83);
    await replaySaved(t, fullThenTaller, () => true, END, CONPTY);
    once(t, [...sixty, END]);
  });

  test("live, not replay: a full screen made taller keeps every row with the Windows mode", async () => {
    const t = term(36, 83, WINDOWS);
    await write(t, sixty.join("\r\n") + "\r\nPS> ");
    t.resize(104, 49);
    await write(t, paint(tail, 49));
    once(t, sixty);
    const plain = term(36, 83);
    await write(plain, sixty.join("\r\n") + "\r\nPS> ");
    plain.resize(104, 49);
    await write(plain, paint(tail, 49));
    expect(sixty.filter((r) => !all(plain).includes(r)).length).toBeGreaterThan(0); // the bug this mode fixes
  });

  // Counts the resizes a replay makes.
  const countingResizes = (t) => {
    const sizes = [];
    const real = t.resize.bind(t);
    t.resize = (cols, rows) => { sizes.push([cols, rows]); real(cols, rows); };
    return sizes;
  };

  test("a wider window with a wrapped line on screen: the session before it loses nothing", async () => {
    // Making the terminal wider turns a wrapped line into one row, which frees
    // a row, and xterm fills it by pulling the newest scrollback row down:
    // here the last line of the session before. The repaint that follows in
    // the stream would be drawn over it. (Windows mode does not change this.)
    const long = "x".repeat(110);
    const first = SIZE(83, 36) + CLEAR_HOME + ["PS> one", "S1-FIRST", "S1-LAST"].join("\r\n");
    const viewWide = [`PS> ${long}`, "S2-OUT", "PS> "];
    const second = SIZE(83, 36) + CLEAR_HOME + `PS> ${long}\r\nS2-OUT\r\nPS> ` + SIZE(124, 49) + paint(viewWide, 49);
    for (const extra of [{}, WINDOWS]) {
      const t = term(36, 83, extra);
      await replaySaved(t, first + SESSION_SENTINEL + second, () => true, END, CONPTY);
      once(t, ["S1-FIRST", "S1-LAST", "S2-OUT", END]);
    }
  });

  test("a session saved without a size replays at the terminal's own size, not at the last one recorded", async () => {
    const sized = SIZE(104, 49) + CLEAR_HOME + "SIZED-OUT";
    const unsized = CLEAR_HOME + "UNSIZED-OUT";
    const later = SIZE(90, 30) + CLEAR_HOME + "LATER-OUT";
    const t = term(24, 80);
    const sizes = countingResizes(t);
    await replaySaved(t, sized + SESSION_SENTINEL + unsized + SESSION_SENTINEL + later, () => true, END, CONPTY);
    // Back to 80 x 24 for the unsized session in the middle, not only at the end.
    expect(sizes).toEqual([[104, 49], [80, 24], [90, 30], [80, 24]]);
    once(t, ["SIZED-OUT", "UNSIZED-OUT", "LATER-OUT", END]);
  });

  test("size marks with nothing between them (a window being dragged) cost one resize", async () => {
    const t = term(36, 83);
    const sizes = countingResizes(t);
    let drag = "";
    for (let w = 84; w <= 120; w++) drag += SIZE(w, 36);
    await replaySaved(t, SIZE(83, 36) + CLEAR_HOME + "before" + drag + paint(["before"], 36), () => true, END, CONPTY);
    expect(sizes).toEqual([[120, 36], [83, 36]]);
    once(t, ["before", END]);
  });

  test("a size mark that falls inside an escape sequence does not break the sequence", async () => {
    // The mark is written between two chunks of output, and a chunk can end
    // anywhere: here in the middle of a colour sequence.
    const t = term(36, 83);
    await replaySaved(t, SIZE(83, 36) + CLEAR_HOME + `${CSI}38;5;` + SIZE(104, 49) + "196mRED-TEXT", () => true, END, CONPTY);
    once(t, ["RED-TEXT", END]); // not "196mRED-TEXT"
  });

  test("size marks that make no sense are ignored, and never reach the terminal", async () => {
    const t = term(36, 83);
    const sizes = countingResizes(t);
    const junk = [
      "0;0", "99999;99999", ";", "abc;def", "83", "83;36;7", "-5;10", "1001;36", "83;501", "9;36", "83;2", "1e2;36",
    ].map((body) => `${ESC}]1337;PlutoSize=${body}${BEL}`).join("");
    await replaySaved(t, junk + CLEAR_HOME + "kept line", () => true, END, CONPTY);
    expect(count(t, "kept line")).toBe(1);
    expect(sizes).toEqual([]);
    expect([t.cols, t.rows]).toEqual([83, 36]);
    // The largest size that is accepted.
    const big = term(36, 83);
    const bigSizes = countingResizes(big);
    await replaySaved(big, SIZE(1000, 500) + "x", () => true, END, CONPTY);
    expect(bigSizes[0]).toEqual([1000, 500]);
  });

  test("a mark prefix with no size after it is text, and swallows nothing", async () => {
    // Looking for "the next BEL" would eat both lines and the title sequence.
    const t = term(36, 83);
    const titles = [];
    t.onTitleChange((title) => titles.push(title));
    const prefix = `${ESC}]1337;PlutoSize=`;
    await replaySaved(t, CLEAR_HOME + "line one\r\n" + prefix + "\r\nline two\r\n" + `${ESC}]0;a title${BEL}` + "line three", () => true, END, CONPTY);
    // xterm itself reads the prefix as the start of an OSC, so "line two" is
    // inside it; what matters is that the replay dropped nothing more: the
    // title sequence after it still arrives.
    once(t, ["line one", "line three", END]);
    expect(titles).toEqual(["a title"]);
  });

  test("output still on its way when the window was made taller is replayed at the old size", async () => {
    // The mark is written when the resize is asked for; lines ConPTY had
    // already produced at 36 rows arrive after it, and only then the repaint
    // for 49 rows. Printed into a 49-row terminal those late lines would not
    // scroll, and the repaint (whose view did scroll) would overwrite lines
    // the live terminal had already moved into scrollback.
    for (const lateCount of [2, 5, 13, 20]) {
      const late = Array.from({ length: lateCount }, (_, i) => `LATE-${i + 1}`);
      const everything = [...sixty, ...late];
      const view = everything.slice(-36); // what the 36-row screen showed when the resize landed
      const saved = SIZE(83, 36) + CLEAR_HOME + sixty.join("\r\n") +
        SIZE(104, 49) + "\r\n" + late.join("\r\n") + paint(view, 49);
      const t = term(36, 83, WINDOWS);
      await replaySaved(t, saved, () => true, END, CONPTY);
      once(t, [...everything, END]);
    }
  });

  test("the screen begins in the middle of a wrapped line and the window gets wider: nothing above it is lost", async () => {
    // Row 1 of the screen is the second half of a long line whose first half
    // is in scrollback. Wider, the two halves become one row; a marker on the
    // half that was on screen would vanish with it.
    const long = "L".repeat(70);
    const shorts = Array.from({ length: 9 }, (_, i) => `short ${i + 1}`);
    const first = SIZE(40, 10) + CLEAR_HOME + ["S1-A", "S1-B"].join("\r\n");
    const second = SIZE(40, 10) + CLEAR_HOME + ["s2 line 1", "s2 line 2", "s2 line 3", long, ...shorts].join("\r\n") +
      SIZE(80, 10) + paint(["L".repeat(30), ...shorts], 10);
    for (const extra of [{}, WINDOWS]) {
      const t = term(10, 40, extra);
      await replaySaved(t, first + SESSION_SENTINEL + second, () => true, END, CONPTY);
      once(t, ["S1-A", "S1-B", "s2 line 1", "s2 line 2", "s2 line 3", ...shorts, END]);
      expect(count(t, "L".repeat(40))).toBeGreaterThan(0); // the long line's first half is still there
    }
  });

  test("a session that never resized keeps its recorded size up to a full repaint of the same height (a clear, a pager exiting)", async () => {
    // ConPTY repaints the whole view after a clear. That paint has exactly
    // the session's own row count; taking it for a resize's repaint replayed
    // everything before it at the terminal's own size. Recorded at 104 x 36,
    // replayed here in a background tab's 80 x 24: the rows drawn by position
    // below row 24 would land on row 24 and overwrite each other.
    const byPosition = Array.from({ length: 34 }, (_, i) => `POS-${i + 1}`);
    const more = Array.from({ length: 30 }, (_, i) => `MORE-${i + 1}`);
    const saved = SIZE(104, 36) + CLEAR_HOME + byPosition.map((l, i) => `${CSI}${i + 1};1H${l}`).join("") +
      "\r\n" + more.join("\r\n") + `${CSI}2J` + paint(["PS> "], 36);
    for (const [rows, cols] of [[24, 80], [36, 104]]) {
      const t = term(rows, cols, WINDOWS);
      const sizes = countingResizes(t);
      await replaySaved(t, saved, () => true, END, CONPTY);
      // 64 lines went by on 36 rows: the first 28 scrolled off before the clear.
      once(t, [...byPosition.slice(0, 28), END]);
      expect(sizes[0] || [cols, rows]).toEqual([104, 36]); // the recorded size comes first, not after the paint
    }
  });

  test("a full paint of the old height between the mark and the repaint is still old-size output", async () => {
    // ConPTY can paint the whole view at the old size (a clear) just before it
    // handles the resize. Only the paint with the new row count is the repaint.
    const view = [...sixty.slice(25), "PS> "];
    const saved = SIZE(83, 36) + CLEAR_HOME + sixty.join("\r\n") + "\r\nPS> " +
      SIZE(104, 49) + paint(["OLD-HEIGHT-FRAME", ...view.slice(1)], 36) + paint(view, 49);
    const t = term(36, 83, WINDOWS);
    const log = [];
    const realWrite = t.write.bind(t);
    const realResize = t.resize.bind(t);
    t.write = (data, cb) => { log.push(String(data).includes("OLD-HEIGHT-FRAME") ? "old frame" : "write"); return realWrite(data, cb); };
    t.resize = (c, r) => { log.push(`resize ${c}x${r}`); realResize(c, r); };
    await replaySaved(t, saved, () => true, END, CONPTY);
    expect(log.indexOf("old frame")).toBeGreaterThan(-1);
    expect(log.indexOf("old frame")).toBeLessThan(log.indexOf("resize 104x49"));
  });

  test("the screen begins two rows into a wrapped line and the window gets wider: the line's tail is not doubled", async () => {
    // 110 characters at 40 columns are three rows; the screen starts at the
    // third. At 80 columns the two rows above it become one: counting them as
    // still two would push the tail row up as well, and the repaint would draw
    // it a second time.
    const long = "L".repeat(110);
    const shorts = Array.from({ length: 9 }, (_, i) => `short ${i + 1}`);
    const saved = SIZE(40, 10) + CLEAR_HOME + ["s line 1", "s line 2", long, ...shorts].join("\r\n") +
      SIZE(80, 10) + paint(["L".repeat(30), ...shorts], 10);
    const t = term(10, 40, WINDOWS);
    await replaySaved(t, saved, () => true, END, CONPTY);
    once(t, ["s line 1", "s line 2", ...shorts, END]);
    expect(all(t).filter((l) => l === "L".repeat(30))).toHaveLength(1);
    expect(all(t).filter((l) => l === "L".repeat(40))).toHaveLength(2);
  });

  test("a resize while a full-screen program had the alternate screen does not touch the history", async () => {
    const saved = SIZE(83, 36) + CLEAR_HOME + five.join("\r\n") + `${CSI}?1049h` + CLEAR_HOME + "EDITOR" +
      SIZE(104, 49) + paint(["EDITOR"], 49) + `${CSI}?1049l`;
    const t = term(36, 83, WINDOWS);
    await replaySaved(t, saved, () => true, END, CONPTY);
    once(t, [...five, END]);
    expect(count(t, "EDITOR")).toBe(0);
  });

  test("a file that holds only marks is not a restore", async () => {
    const t = term(36, 83);
    const sizes = countingResizes(t);
    expect(await replaySaved(t, SESSION_SENTINEL + SIZE(104, 49) + SESSION_SENTINEL + SIZE(83, 36), () => true, END, CONPTY)).toBe(false);
    expect(sizes).toEqual([]);
    expect(count(t, END)).toBe(0);
  });

  test("off ConPTY the replay resizes and nothing more: rows a taller resize pulls down stay down, as they did live", async () => {
    // On macOS and Linux nothing repaints after a resize, and the live
    // terminal did pull those rows into view.
    const saved = SIZE(83, 36) + CLEAR_HOME + sixty.join("\r\n") + SIZE(83, 49) + "\r\nAFTER";
    const plain = term(36, 83);
    const writes = [];
    const real = plain.write.bind(plain);
    plain.write = (data, cb) => { writes.push(String(data)); return real(data, cb); };
    await replaySaved(plain, saved, () => true, END);
    once(plain, [...sixty, "AFTER", END]);
    const pushBack = `${CSI}9999;1H\n`;
    const afterAt = writes.findIndex((w) => w.includes("AFTER"));
    // Nothing was written between the 60 lines and "AFTER".
    expect(writes[afterAt - 1]).toContain("ROW-60");
    // The same bytes on ConPTY do get a push-back there.
    const conpty = term(36, 83);
    const conptyWrites = [];
    const realC = conpty.write.bind(conpty);
    conpty.write = (data, cb) => { conptyWrites.push(String(data)); return realC(data, cb); };
    await replaySaved(conpty, saved, () => true, END, CONPTY);
    const at = conptyWrites.findIndex((w) => w.includes("AFTER"));
    expect(conptyWrites[at - 1].startsWith(pushBack)).toBe(true);
  });

  test("text with no size mark replays exactly as before", async () => {
    const a = term(36, 83);
    const b = term(36, 83);
    const text = CLEAR_HOME + view.join("\r\n");
    await replaySaved(a, text, () => true, END, CONPTY);
    await write(b, text);
    expect(history(a)).toEqual([...all(b).filter((l) => l !== ""), END]);
  });

  test("two hundred width changes over a long history: one resize each, nothing lost", async () => {
    const t = term(36, 83, { scrollback: 5000 });
    let saved = SIZE(83, 36);
    for (let i = 0; i < 3000; i++) saved += `history line ${i}\r\n`;
    // Each paint redraws the 36 rows on screen (the last 35 history lines and
    // an empty row), as ConPTY does after a width change.
    const onScreen = Array.from({ length: 35 }, (_, i) => `history line ${2965 + i}`);
    for (let i = 0; i < 200; i++) saved += SIZE(83 + ((i + 1) % 2) * 21, 36) + paint(onScreen, 36);
    const sizes = countingResizes(t);
    await replaySaved(t, saved, () => true, END, CONPTY);
    for (const n of [0, 1500, 2964, 2965, 2999]) {
      expect([n, all(t).filter((l) => l === `history line ${n}`).length]).toEqual([n, 1]);
    }
    // 200 recorded changes (the first size is the terminal's own already) and
    // none added by the replay itself.
    expect(sizes).toHaveLength(200);
  });
});
