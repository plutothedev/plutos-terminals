// (C)
import { describe, it, expect } from "vitest";
import { isMouseReport, isMouseClick, inputKind } from "./userInput.js";

const E = String.fromCharCode(27);

describe("mouse reports", () => {
  it("knows a mouse report in each encoding xterm sends through onData", () => {
    expect(isMouseReport(E + "[<35;12;7M")).toBe(true); // SGR motion
    expect(isMouseReport(E + "[<0;1;1m")).toBe(true); // SGR release
    expect(isMouseReport(E + "[<35;12;7M" + E + "[<35;13;7M")).toBe(true);
    expect(isMouseReport(E + "[32;10;5M")).toBe(true); // urxvt
    // X10 (CSI M and three bytes) goes to xterm's onBinary, never onData.
    expect(isMouseReport(E + "[M" + String.fromCharCode(67, 45, 40))).toBe(false);
  });

  it("takes nothing a person types for one", () => {
    for (const typed of ["a", "M", E, E + "[A", E + "[200~hi" + E + "[201~", E + "[<35;12;7", E + "[M" + "ab", E + "[<1;2;3Mx", "[<35;12;7M", E + "[I"]) {
      expect(isMouseReport(typed), JSON.stringify(typed)).toBe(false);
    }
    expect(isMouseReport(undefined)).toBe(false);
  });

  it("tells a click from a release, motion and the wheel", () => {
    expect(isMouseClick(E + "[<0;22;6M")).toBe(true); // left press
    expect(isMouseClick(E + "[<2;22;6M")).toBe(true); // right press
    expect(isMouseClick(E + "[<16;22;6M")).toBe(true); // ctrl + left press
    expect(isMouseClick(E + "[<35;12;7M" + E + "[<0;12;7M")).toBe(true); // motion, then a press
    expect(isMouseClick(E + "[<0;22;6m")).toBe(false); // release
    expect(isMouseClick(E + "[<32;22;6M")).toBe(false); // drag motion
    expect(isMouseClick(E + "[<35;22;6M")).toBe(false); // motion, no button
    expect(isMouseClick(E + "[<64;22;6M")).toBe(false); // wheel up
    expect(isMouseClick(E + "[<65;22;6M")).toBe(false); // wheel down
    expect(isMouseClick(E + "[32;22;6M")).toBe(true); // urxvt left press
    expect(isMouseClick(E + "[35;22;6M")).toBe(false); // urxvt release
    expect(isMouseClick(E + "[67;22;6M")).toBe(false); // urxvt motion
    expect(isMouseClick(E + "[96;22;6M")).toBe(false); // urxvt wheel
    expect(isMouseClick("1")).toBe(false);
  });
});

describe("inputKind", () => {
  it("routes each kind of onData", () => {
    expect(inputKind(E + "[?62;22c", false)).toBe("reply");
    expect(inputKind(E + "[<0;22;6M", false)).toBe("reply"); // whatever it looks like
    expect(inputKind(E + "[<0;22;6M", true)).toBe("click");
    expect(inputKind(E + "[<35;22;6M", true)).toBe("mouse");
    expect(inputKind(E + "[<0;22;6m", true)).toBe("mouse");
    expect(inputKind(E + "[<64;22;6M", true)).toBe("mouse");
    expect(inputKind("1", true)).toBe("user");
    expect(inputKind(E + "[A", true)).toBe("user");
    expect(inputKind(E + "[200~text" + E + "[201~", true)).toBe("user");
  });
});
