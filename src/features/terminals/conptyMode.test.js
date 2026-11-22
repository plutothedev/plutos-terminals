// (C)
// @vitest-environment happy-dom
//
// xterm's Windows mode: which system gets it, and what it changes on the real
// xterm (the reason it is set at all).
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Terminal } from "@xterm/xterm";
import { applyConptyMode } from "./conptyMode.js";

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
const ESC = String.fromCharCode(27);
const CSI = ESC + "[";

let savedUa;
const setUserAgent = (value) => Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => value });
const write = (t, s) => new Promise((r) => t.write(s, r));
const all = (t) => {
  const b = t.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
  return out;
};

beforeEach(() => {
  savedUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
});
afterEach(() => {
  if (savedUa) Object.defineProperty(navigator, "userAgent", savedUa);
  else delete navigator.userAgent;
});

describe("applyConptyMode", () => {
  test("on Windows the terminal is told it talks to ConPTY, with no build number", () => {
    setUserAgent(WINDOWS);
    const term = new Terminal({ rows: 24, cols: 80, allowProposedApi: true });
    applyConptyMode(term);
    expect(term.options.windowsPty).toEqual({ backend: "conpty" });
  });

  test("off Windows nothing is set", () => {
    setUserAgent(LINUX);
    const term = new Terminal({ rows: 24, cols: 80, allowProposedApi: true });
    applyConptyMode(term);
    expect(term.options.windowsPty).toEqual({});
  });

  test("a terminal that refuses the option does not throw", () => {
    setUserAgent(WINDOWS);
    const term = { get options() { throw new Error("disposed"); } };
    expect(() => applyConptyMode(term)).not.toThrow();
  });

  // What the mode is for, with ConPTY's repaint in the shape read from a real
  // capture: after 60 lines on 36 rows, the view for 49 rows is "lines 26 to
  // 60 and the prompt at the TOP, 13 blank rows below".
  test("a full screen made taller keeps every row with the mode, and loses rows without it", async () => {
    setUserAgent(WINDOWS);
    const sixty = Array.from({ length: 60 }, (_, i) => `ROW-${i + 1}`);
    const view = [...sixty.slice(25), "PS> "];
    const paint = `${CSI}?25l${CSI}H` + Array.from({ length: 49 }, (_, i) => (view[i] || "") + `${CSI}K`).join("\r\n") + `${CSI}36;5H${CSI}?25h`;
    const run = async (withMode) => {
      const t = new Terminal({ rows: 36, cols: 83, scrollback: 1000, allowProposedApi: true });
      if (withMode) applyConptyMode(t);
      await write(t, sixty.join("\r\n") + "\r\nPS> ");
      t.resize(104, 49);
      await write(t, paint);
      const lines = all(t);
      return sixty.filter((row) => lines.filter((l) => l === row).length !== 1);
    };
    expect(await run(true)).toEqual([]);
    expect((await run(false)).length).toBeGreaterThan(0); // the bug the mode fixes
  });
});
