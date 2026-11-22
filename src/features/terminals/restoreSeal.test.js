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
    expect(timers).toBeLessThan(10);
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

  test("no marker, or one whose line is gone, asks for nothing", async () => {
    const t = make();
    expect(pushBackHistory(t, null)).toBe("");
    const marker = t.registerMarker(0);
    marker.dispose();
    expect(pushBackHistory(t, marker)).toBe("");
  });
});
