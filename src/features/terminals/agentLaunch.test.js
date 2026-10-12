// (C)
import { describe, it, expect } from "vitest";
import { isSessionId, launchesClaude, withSessionId, withResume, planAgentLaunch, withPaneAgentSession, stripAgentSessions } from "./agentLaunch.js";

const ID = "0f9b1c2d-3e4f-4a5b-8c6d-7e8f90a1b2c3";
const ID2 = "11111111-2222-4333-8444-555555555555";

describe("isSessionId", () => {
  it("takes only a canonical lowercase UUID", () => {
    expect(isSessionId(ID)).toBe(true);
    expect(isSessionId(ID.toUpperCase())).toBe(false);
    expect(isSessionId("0F9b1c2d" + ID.slice(8))).toBe(false);
    expect(isSessionId(ID + " ")).toBe(false);
    expect(isSessionId(`${ID};rm -rf ~`)).toBe(false);
    expect(isSessionId("$(id)")).toBe(false);
    expect(isSessionId(undefined)).toBe(false);
  });
});

describe("launchesClaude", () => {
  it("is true for a plain claude launch, with or without known flags", () => {
    expect(launchesClaude("claude")).toBe(true);
    expect(launchesClaude("  claude --model opus")).toBe(true);
    expect(launchesClaude("claude --dangerously-skip-permissions")).toBe(true);
    expect(launchesClaude("claude --model=opus --verbose")).toBe(true);
    expect(launchesClaude("claude --append-system-prompt 'be brief and kind'")).toBe(true);
    expect(launchesClaude('claude --add-dir ../api ../web --permission-mode plan')).toBe(true);
    expect(launchesClaude("claude --debug")).toBe(true);
    expect(launchesClaude("claude -n api-agent")).toBe(true);
  });

  it("is false when anything after claude is not a known flag or its value", () => {
    for (const cmd of [
      'claude "fix the login bug"',
      "claude fix",
      "claude --model opus fix",
      "claude mcp list",
      "claude doctor",
      "claude -w feature",
      "claude --worktree",
      "claude --bg",
      "claude --cloud",
      "claude --teleport",
      "claude --desktop",
      "claude --remote-control",
      "claude -v",
      "claude --model",
      "claude --verbose=1",
      "claude --add-dir",
      "claude --brand-new-flag",
      "claude --model opus && echo done",
      "claude --append-system-prompt 'unclosed",
      "claude --append-system-prompt " + String.fromCharCode(92) + "x",
    ]) {
      expect(launchesClaude(cmd)).toBe(false);
    }
  });

  it("is false for anything else", () => {
    expect(launchesClaude("claudes")).toBe(false);
    expect(launchesClaude("claude-code")).toBe(false);
    expect(launchesClaude("cd app && claude")).toBe(false);
    expect(launchesClaude("npx claude")).toBe(false);
    expect(launchesClaude("")).toBe(false);
    expect(launchesClaude(null)).toBe(false);
  });

  it("is false when the command already picks a conversation or runs non-interactively", () => {
    for (const cmd of [
      "claude --resume",
      "claude --resume abc",
      `claude --resume=${ID}`,
      "claude -r",
      "claude -c",
      "claude --continue",
      "claude -p hello",
      "claude --print hello",
      `claude --session-id ${ID}`,
      "claude --fork-session",
      "claude --from-pr 12",
      "claude -pc",
    ]) {
      expect(launchesClaude(cmd)).toBe(false);
    }
  });
});

describe("withSessionId and withResume", () => {
  it("put the flag straight after claude and keep the rest as typed", () => {
    expect(withSessionId("claude", ID)).toBe(`claude --session-id ${ID}`);
    expect(withSessionId("  claude --model opus --append-system-prompt 'be brief'", ID)).toBe(`  claude --session-id ${ID} --model opus --append-system-prompt 'be brief'`);
    expect(withSessionId("claude --model opus 'fix the bug'", ID)).toBe("claude --model opus 'fix the bug'");
    expect(withResume("claude --model opus", ID)).toBe(`claude --resume ${ID} --model opus`);
  });

  it("leave the command alone for a bad id or a command they do not own", () => {
    expect(withSessionId("claude", "not-a-uuid")).toBe("claude");
    expect(withResume("claude", `${ID} && curl x`)).toBe("claude");
    expect(withResume("codex", ID)).toBe("codex");
    expect(withSessionId("claude -c", ID)).toBe("claude -c");
  });
});

describe("planAgentLaunch", () => {
  it("gives the first claude line a fresh id", () => {
    expect(planAgentLaunch(["cd api", "claude"], { newId: ID })).toEqual({
      commands: ["cd api", `claude --session-id ${ID}`],
      session: { cli: "claude", id: ID },
    });
  });

  it("resumes a session that exists, and gives no id twice", () => {
    expect(planAgentLaunch(["claude", "claude"], { resumeId: ID, newId: ID2 })).toEqual({
      commands: [`claude --resume ${ID}`, "claude"],
      session: { cli: "claude", id: ID },
    });
  });

  it("starts fresh when the resume id is not a session id", () => {
    expect(planAgentLaunch(["claude"], { resumeId: "../x", newId: ID2 }).commands).toEqual([`claude --session-id ${ID2}`]);
  });

  it("records nothing when no line launches claude", () => {
    expect(planAgentLaunch(["npm run dev"], { newId: ID })).toEqual({ commands: ["npm run dev"], session: null });
    expect(planAgentLaunch(undefined, { newId: ID })).toEqual({ commands: [], session: null });
  });
});

describe("withPaneAgentSession and stripAgentSessions", () => {
  const S = { cli: "claude", id: ID };
  const split = { id: "split1", dir: "row", ratio: 50, a: { id: "t1" }, b: { id: "pane2", cwd: "/x" } };
  const state = () => ({
    panels: [
      { id: "p1", tabs: [{ id: "t1", layout: split }, { id: "t2" }], activeTabId: "t1" },
      { id: "p2", tabs: [{ id: "t3" }], activeTabId: "t3" },
    ],
  });

  it("keeps a root pane's conversation on the tab, any other pane's on its leaf", () => {
    const a = withPaneAgentSession(state(), "t1", S);
    expect(a.panels[0].tabs[0].agentSession).toEqual(S);
    const st = state();
    const b = withPaneAgentSession(st, "pane2", S);
    expect(b.panels[0].tabs[0].layout.b).toEqual({ id: "pane2", cwd: "/x", agentSession: S });
    expect(b.panels[0].tabs[0].agentSession).toBeUndefined();
    expect(b.panels[1]).toBe(st.panels[1]);
    expect(b.panels[0].tabs[1]).toBe(st.panels[0].tabs[1]);
    expect(withPaneAgentSession(st, "t3", S).panels[1].tabs[0].agentSession).toEqual(S);
  });

  it("changes nothing when the tab or pane is gone", () => {
    const st = state();
    expect(withPaneAgentSession(st, "gone", S)).toBe(st);
    expect(withPaneAgentSession(st, "pane9", S)).toBe(st);
    expect(withPaneAgentSession(null, "t1", S)).toBeNull();
  });

  it("strips the conversation from a tab and every pane", () => {
    const tab = { id: "t1", agentSession: S, layout: { ...split, b: { id: "pane2", agentSession: S } } };
    const out = stripAgentSessions(tab);
    expect(out.agentSession).toBeUndefined();
    expect(out.layout.b.agentSession).toBeUndefined();
    expect(tab.agentSession).toEqual(S);
  });
});

describe("the copies that must start fresh", () => {
  it("a loaded workspace carries no conversation, on the tab or any pane", async () => {
    const { cloneWorkspaceFresh } = await import("./workspaceModel.js");
    const S = { cli: "claude", id: ID };
    const ws = {
      activePanelId: "p1",
      panels: [{ id: "p1", activeTabId: "t1", tabs: [
        { id: "t1", agentSession: S, activePaneId: "t1", layout: { id: "s1", dir: "row", ratio: 50, a: { id: "t1", agentSession: S }, b: { id: "x2", agentSession: S } } },
        { id: "t2", agentSession: S },
      ] }],
    };
    const out = cloneWorkspaceFresh(ws);
    expect(JSON.stringify(out)).not.toContain(ID);
  });

  it("duplicate and detach strip it too (pinned by source: they live in a React hook)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(process.cwd(), "src/features/terminals/hooks/useWorkspaceTree.js"), "utf8");
    const dup = src.slice(src.indexOf("const duplicateTab = useCallback"), src.indexOf("const detachTab = useCallback"));
    expect(dup).toContain("agentSession: undefined");
    const det = src.slice(src.indexOf("const detachTab = useCallback"), src.indexOf("const closeOtherTabs = useCallback"));
    expect(det).toContain("const tabCopy = stripAgentSessions(src);");
  });
});
