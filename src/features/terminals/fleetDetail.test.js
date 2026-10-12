// (C)
import { describe, it, expect } from "vitest";
import { tabDetail, detailLine } from "./fleetDetail.js";

const split = { id: "s", dir: "row", ratio: 50, a: { id: "t1" }, b: { id: "p2" } };

describe("tabDetail", () => {
  it("is null when no pane of the tab reported", () => {
    expect(tabDetail({ id: "t1" }, {}, {})).toBeNull();
    expect(tabDetail({ id: "t1" }, { other: { state: "done" } }, {})).toBeNull();
  });

  it("takes the waiting pane first, then a failed one, then the first", () => {
    const tab = { id: "t1", layout: split };
    const details = { t1: { state: "error", app: "cargo" }, p2: { state: "blocked", kind: "permission", msg: "Apply?" } };
    expect(tabDetail(tab, details, { p2: "waiting" })).toEqual({ pane: "shell ·2", failed: false, kind: "permission", app: "", msg: "Apply?" });
    expect(tabDetail(tab, details, {})).toEqual({ pane: "", failed: true, kind: null, app: "cargo", msg: "" });
    expect(tabDetail(tab, { p2: { state: "done" } }, {})).toEqual({ pane: "shell ·2", failed: false, kind: null, app: "", msg: "" });
  });

  it("cleans program text for display", () => {
    const d = tabDetail({ id: "t1" }, { t1: { state: "blocked", app: "a" + String.fromCodePoint(0x202e) + "b", msg: "x".repeat(300) } }, {});
    expect(d.app).toBe("ab");
    expect([...d.msg].length).toBe(120);
  });
});

describe("which pane spoke", () => {
  it("names a pane folded in from another host by that host", () => {
    const tab = { id: "t1", label: "work", layout: { ...split, b: { id: "p2", connection: { host: "prod.example", user: "deploy" } } } };
    const d = tabDetail(tab, { p2: { state: "blocked", kind: "auth", app: "claude-code", msg: "paste your key" } }, { p2: "waiting" });
    expect(d.pane).toBe("work ·2 (deploy@prod.example)");
    expect(detailLine(d, "waiting")).toBe("work ·2 (deploy@prod.example): claude-code: paste your key");
  });
});

describe("detailLine", () => {
  it("labels the program's words as its own", () => {
    expect(detailLine({ app: "claude-code", msg: "Edit 3 files?" }, "waiting")).toBe("claude-code: Edit 3 files?");
    expect(detailLine({ app: "", msg: "Edit?" }, "waiting")).toBe("program: Edit?");
    expect(detailLine({ app: "x", kind: "question", msg: "" }, "waiting")).toBe("x has a question");
    expect(detailLine({ app: "", kind: "auth", msg: "" }, "waiting")).toBe("program asks you to sign in");
    expect(detailLine({ app: "cargo", failed: true, msg: "" }, "done")).toBe("cargo stopped with an error");
    expect(detailLine({ app: "x", msg: "" }, "active")).toBe("");
    expect(detailLine(null, "waiting")).toBe("");
  });
});
