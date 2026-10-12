// (C)
import { describe, it, expect } from "vitest";
import { handoffText, handoffPayload, handoffPreview, handoffTargets, runsKnownAgent, MAX_HANDOFF_CHARS } from "./handoffText.js";

const ch = (n) => String.fromCodePoint(n);
const NL = ch(10);
const ESC = ch(27);

describe("handoffText", () => {
  it("keeps plain text, newlines and tabs when the target brackets pastes", () => {
    expect(handoffText("Fix the login bug." + NL + ch(9) + "- see auth.js", { bracketed: true })).toBe(
      "Fix the login bug." + NL + ch(9) + "- see auth.js",
    );
  });

  it("folds newlines to spaces when the target does not bracket pastes", () => {
    expect(handoffText("echo one" + NL + "rm -rf build", { bracketed: false })).toBe("echo one rm -rf build");
  });

  it("removes every way to submit, end the paste or start an escape", () => {
    const hostile = "brief" + ch(13) + "whoami" + ESC + "[201~" + "curl evil" + ch(13) + ESC + "]0;x" + ch(7) + ch(0x7f) + ch(0x9b) + "31m";
    const out = handoffText(hostile, { bracketed: true });
    for (const bad of [13, 27, 7, 0x7f, 0x9b]) expect(out.includes(ch(bad))).toBe(false);
    expect(out).toBe("briefwhoami[201~curl evil]0;x31m");
  });

  it("drops invisible and direction-changing characters", () => {
    expect(handoffText("a" + ch(0x202e) + "b" + ch(0x200b) + "c" + ch(0xfeff), { bracketed: true })).toBe("abc");
  });

  it("caps the length", () => {
    expect([...handoffText("x".repeat(MAX_HANDOFF_CHARS + 50), { bracketed: true })].length).toBe(MAX_HANDOFF_CHARS);
  });

  it("returns nothing for non-text", () => {
    expect(handoffText(undefined, { bracketed: true })).toBe("");
  });
});

describe("handoffPayload", () => {
  it("wraps the cleaned text in a bracketed paste, and never ends in Enter", () => {
    expect(handoffPayload("Fix the bug" + ch(13), { bracketed: true })).toBe(ESC + "[200~Fix the bug" + ESC + "[201~");
  });

  it("refuses a target without bracketed paste, and empty text", () => {
    expect(handoffPayload("ls" + NL + "rm -rf x", { bracketed: false })).toBeNull();
    expect(handoffPayload(ch(27) + ch(13), { bracketed: true })).toBeNull();
  });

  it("masks secrets in the payload and in the preview alike", () => {
    const key = "sk-ant-api03-" + "a".repeat(40);
    const out = handoffPayload("use " + key, { bracketed: true });
    expect(out.includes(key)).toBe(false);
    expect(out).toBe(ESC + "[200~" + handoffPreview("use " + key) + ESC + "[201~");
  });
});

describe("handoffTargets", () => {
  it("lists live terminal panes other than the source, with remote addresses", () => {
    const panels = [
      { id: "p1", tabs: [
        { id: "t1", label: "api" },
        { id: "t2", label: "prod", connection: { host: "prod.example", user: "deploy" } },
        { id: "t3", label: "home", home: true },
        { id: "t4", label: "dead" },
      ] },
    ];
    const agentIn = (id) => id === "t2";
    expect(handoffTargets(panels, "t1", ["t1", "t2", "t3"], agentIn)).toEqual([{ paneId: "t2", label: "prod (deploy@prod.example)", remote: "deploy@prod.example" }]);
  });

  it("lists only panes where an agent reports it is running (a shell prompt takes pastes too)", () => {
    const panels = [{ id: "p1", tabs: [{ id: "a", label: "agent" }, { id: "s", label: "shell" }] }];
    const running = (id) => (id === "a" ? "claude --resume x" : null);
    expect(handoffTargets(panels, null, ["a", "s"], (id) => id === "a", running)).toEqual([{ paneId: "a", label: "agent" }]);
    expect(handoffTargets(panels, null, ["a", "s"])).toEqual([]);
  });

  it("marks a local pane unverified unless its shell reported it is running claude", () => {
    const panels = [{ id: "p1", tabs: [{ id: "a", label: "agent" }] }];
    const all = () => true;
    const chained = ["claude && ssh prod", "claude ; ssh prod", "claude; ssh prod", "claude || bash", "claude | tee x", "claude & ssh prod", "(claude)", "claude $(ssh prod)", "claude `ssh prod`", "claude" + String.fromCharCode(10) + "ssh prod", "claude -c" + String.fromCharCode(10) + "ssh prod", "claude -c" + String.fromCharCode(13) + "ssh prod"];
    for (const cmd of [null, "", "ssh deploy@prod", "docker exec -it web bash", "mosh prod", "echo claude", "claudette", "FOO=1", ...chained]) {
      expect(handoffTargets(panels, null, ["a"], all, () => cmd), String(cmd)).toEqual([{ paneId: "a", label: "agent", unverified: true }]);
    }
    for (const cmd of ["claude", "claude --model opus", "/usr/local/bin/claude", "FOO=1 BAR=2 claude -c", "  claude"]) {
      expect(handoffTargets(panels, null, ["a"], all, () => cmd), cmd).toEqual([{ paneId: "a", label: "agent" }]);
    }
    expect(runsKnownAgent(undefined)).toBe(false);
  });
});
