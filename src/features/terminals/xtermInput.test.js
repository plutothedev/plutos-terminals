// @vitest-environment happy-dom
// (C)
// TerminalPane and the phone page tell the user's input from xterm's own
// replies to programs by xterm's internal onUserInput signal, which fires just
// before onData for keys, paste and IME and never for a reply. It is private
// API, so this pins both halves against the real xterm: the signal is where
// the code looks for it, and it separates the two kinds of input.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Terminal } from "@xterm/xterm";
import { watchUserInput } from "./userInput.js";

const ESC = String.fromCharCode(27);

describe("xterm's user-input signal", () => {
  it("marks paste as the user's and leaves every reply to a program unmarked", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true });
    term.open(host);
    const signal = term._core?.coreService?.onUserInput;
    expect(typeof signal).toBe("function");
    let user = false;
    signal(() => {
      user = true;
    });
    const seen = [];
    term.onData((d) => {
      seen.push({ d, user });
      user = false;
    });
    // Device attributes, a mode report, the extended cursor report and a
    // status report: all answered by xterm itself.
    await new Promise((resolve) => term.write(ESC + "[c" + ESC + "[?2026$p" + ESC + "[?6n" + ESC + "[5n", resolve));
    const replies = seen.splice(0);
    expect(replies.length).toBeGreaterThanOrEqual(4);
    expect(replies.every((r) => r.user === false)).toBe(true);
    term.paste("hello");
    expect(seen.length).toBe(1);
    expect(seen[0].user).toBe(true);
    term.dispose();
  });

  it("fires onUserInput before onData, and only for user input, in the source this build ships", () => {
    const src = readFileSync(path.join(process.cwd(), "node_modules/@xterm/xterm/src/common/services/CoreService.ts"), "utf8");
    const userFire = src.indexOf("this._onUserInput.fire()");
    const dataFire = src.indexOf("this._onData.fire(data)");
    expect(userFire).toBeGreaterThan(-1);
    expect(dataFire).toBeGreaterThan(userFire);
    expect(src.slice(src.lastIndexOf("if (wasUserInput)", userFire), userFire)).toContain("if (wasUserInput)");
  });
});

describe("watchUserInput", () => {
  const open = () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true });
    term.open(host);
    const input = watchUserInput(term);
    const seen = [];
    term.onData((d) => seen.push({ d, user: input.take(false) }));
    return { term, input, seen };
  };
  const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

  it("says whose each onData is, against the real xterm", async () => {
    const { term, input, seen } = open();
    expect(input.classifies).toBe(true);
    term.input("y", true);
    await write(term, ESC + "[c");
    term.paste("hi");
    await write(term, ESC + "[?2026$p" + ESC + "[6n");
    expect(seen.map((x) => x.user)).toEqual([true, false, true, false, false]);
    term.dispose();
  });

  it("never carries a mark over to the next onData", async () => {
    const { term, seen } = open();
    term.input("y", true);
    await write(term, ESC + "[c");
    await write(term, ESC + "[c");
    expect(seen.map((x) => x.user)).toEqual([true, false, false]);
    term.dispose();
  });

  it("falls back to the caller's guess when xterm has no signal", () => {
    const input = watchUserInput({});
    expect(input.classifies).toBe(false);
    expect(input.take(true)).toBe(false);
    expect(input.take(false)).toBe(true);
  });
});
