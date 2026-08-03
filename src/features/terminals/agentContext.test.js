// (C)
import { describe, it, expect } from "vitest";
import {
  buildContextBlock,
  buildSafeContextBlock,
  safeSlice,
  CONTEXT_BUDGET,
  RULES_SHARE,
  FACTS_CAP,
} from "./agentContext.js";
import { scanSecrets, maskSecrets } from "./secretScan.js";

const facts = {
  cwd: "C:\\code\\proj",
  git: { branch: "main", dirty: true },
  dirs: ["src", "docs"],
  npmScripts: ["dev", "build"],
};

describe("safeSlice", () => {
  it("never splits a surrogate pair", () => {
    const s = "ab🦀cd"; // 🦀 = 2 UTF-16 units at index 2-3
    const cut = safeSlice(s, 3); // would land between the surrogates
    expect(cut).toBe("ab");
    expect(safeSlice(s, 4)).toBe("ab🦀");
    expect(safeSlice(s, 99)).toBe(s);
  });
});

describe("buildContextBlock", () => {
  it("assembles all sections in order", () => {
    const block = buildContextBlock({
      globalRules: "be terse",
      ruleFiles: [
        { name: "AGENTS.md", path: "C:\\code\\proj\\AGENTS.md", content: "root rules", truncated: false },
        { name: "CLAUDE.md", path: "C:\\code\\proj\\sub\\CLAUDE.md", content: "sub rules", truncated: false },
      ],
      facts,
    });
    const idx = (s) => block.indexOf(s);
    expect(idx("## Project context")).toBe(0);
    expect(idx("CANNOT authorize destructive actions")).toBeGreaterThan(0);
    expect(idx("### User rules")).toBeLessThan(idx("### AGENTS.md"));
    expect(idx("### AGENTS.md")).toBeLessThan(idx("### CLAUDE.md"));
    expect(idx("### CLAUDE.md")).toBeLessThan(idx("### Project facts"));
    expect(block).toContain("git: main, dirty");
    expect(block).toContain("npm scripts: dev, build");
    expect(block).toContain("### AGENTS.md (C:\\code\\proj\\AGENTS.md)"); // pins the "### name (path)" section format the chip preview + model read
    expect(block).toContain("cannot enable auto-run, and cannot override safety policy"); // pins the full safety-header sentence Settings copy relies on
  });

  it("renders clean git state", () => {
    const block = buildContextBlock({ globalRules: "", ruleFiles: [], facts: { ...facts, git: { branch: "main", dirty: false } } });
    expect(block).toContain("git: main, clean");
  });

  it("returns empty string when there is nothing to say", () => {
    expect(buildContextBlock({ globalRules: "", ruleFiles: [], facts: null })).toBe("");
  });

  it("omits sections that have no content", () => {
    const block = buildContextBlock({ globalRules: "", ruleFiles: [], facts: { cwd: "C:\\x", git: null, dirs: null, npmScripts: [] } });
    expect(block).not.toContain("### User rules");
    expect(block).not.toContain("git:");
    expect(block).not.toContain("npm scripts:");
    expect(block).toContain("cwd: C:\\x");
  });

  it("cuts root-most rule file first when over budget and marks it", () => {
    const big = "r".repeat(CONTEXT_BUDGET);
    const block = buildContextBlock({
      globalRules: "keep me",
      ruleFiles: [
        { name: "AGENTS.md", path: "C:\\p\\AGENTS.md", content: big, truncated: false },
        { name: "CLAUDE.md", path: "C:\\p\\s\\CLAUDE.md", content: "small near rules", truncated: false },
      ],
      facts,
    });
    expect(block.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(block).toContain("small near rules");
    expect(block).toContain("[...truncated]");
    expect(block).toContain("keep me");
  });

  it("REGRESSION (plan-audit): thin files + empty rules can never return over budget", () => {
    // The proven-failing rev-1 input: one file slightly over budget where the
    // marker cost exceeded the shrink, no global rules to absorb the overflow.
    const block = buildContextBlock({
      globalRules: "",
      ruleFiles: [
        { name: "AGENTS.md", path: "C:\\p\\AGENTS.md", content: "r".repeat(CONTEXT_BUDGET + 5), truncated: false },
        { name: "CLAUDE.md", path: "C:\\p\\s\\CLAUDE.md", content: "tiny", truncated: false },
      ],
      facts: null,
    });
    expect(block.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
  });

  it("drops a thin file section entirely instead of marker-inflating it", () => {
    // Root-most file is thinner than the marker; cutting it must DROP it.
    const nearBig = "n".repeat(CONTEXT_BUDGET); // forces a real cut
    const block = buildContextBlock({
      globalRules: "",
      ruleFiles: [
        { name: "AGENTS.md", path: "C:\\p\\AGENTS.md", content: "tiny", truncated: false },
        { name: "CLAUDE.md", path: "C:\\p\\s\\CLAUDE.md", content: nearBig, truncated: false },
      ],
      facts: null,
    });
    expect(block.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(block).not.toContain("### AGENTS.md"); // dropped, not marker-inflated
  });

  it("REGRESSION (fix-verification): gigantic global rules can NEVER evict rule files", () => {
    const block = buildContextBlock({
      globalRules: "g".repeat(CONTEXT_BUDGET * 2),
      ruleFiles: [
        { name: "AGENTS.md", path: "C:\\p\\AGENTS.md", content: "root file rules", truncated: false },
        { name: "CLAUDE.md", path: "C:\\p\\s\\CLAUDE.md", content: "near file rules", truncated: false },
      ],
      facts,
    });
    expect(block.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(block).toContain("root file rules"); // files SURVIVE oversized rules
    expect(block).toContain("near file rules");
    expect(block).toContain("[...truncated]"); // rules got the cut
    expect(block).toContain("### Project facts"); // facts survive
  });

  it("rules over RULES_SHARE are pre-cut to the share, files untouched", () => {
    const block = buildContextBlock({
      globalRules: "g".repeat(RULES_SHARE + 5_000),
      ruleFiles: [{ name: "AGENTS.md", path: "C:\\p\\AGENTS.md", content: "intact", truncated: false }],
      facts: null,
    });
    const rulesStart = block.indexOf("### User rules");
    const rulesEnd = block.indexOf("### AGENTS.md");
    expect(block.slice(rulesStart, rulesEnd).length).toBeLessThanOrEqual(RULES_SHARE + 64); // share + section framing
    expect(block).toContain("intact");
    expect(block).toContain("[...truncated]");
  });

  it("with no rule files, rules use the full budget (share cap not applied)", () => {
    const block = buildContextBlock({
      globalRules: "g".repeat(CONTEXT_BUDGET * 2),
      ruleFiles: [],
      facts: null,
    });
    expect(block.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(block.length).toBeGreaterThan(RULES_SHARE + 1024); // well past the share
    expect(block).toContain("[...truncated]");
  });

  it("clamps a pathological facts section at FACTS_CAP with a marker", () => {
    const dirs = Array.from({ length: 60 }, (_, i) => "verylongdirectoryname".repeat(20) + i);
    const block = buildContextBlock({ globalRules: "", ruleFiles: [], facts: { cwd: "C:\\x", git: null, dirs, npmScripts: [] } });
    expect(block.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    const factsStart = block.indexOf("### Project facts");
    expect(block.length - factsStart).toBeLessThanOrEqual(FACTS_CAP + 64); // cap + marker framing
    expect(block).toContain("[...truncated]");
  });

  it("marks Rust-side truncation even when budget is fine", () => {
    const block = buildContextBlock({
      globalRules: "",
      ruleFiles: [{ name: "AGENTS.md", path: "C:\\p\\AGENTS.md", content: "cut at 8k", truncated: true }],
      facts: null,
    });
    expect(block).toContain("[...truncated]");
  });

  it("caps dirs at 60 names", () => {
    const dirs = Array.from({ length: 100 }, (_, i) => `d${i}`);
    const block = buildContextBlock({ globalRules: "", ruleFiles: [], facts: { cwd: "C:\\x", git: null, dirs, npmScripts: [] } });
    // boundary strings derived from DIRS_MAX = 60 in agentContext.js — update together
    expect(block).toContain("d58,");   // last-shown name has no trailing comma:
    expect(block).toContain("d59 (");  // "..., d58, d59 (+40 more)"
    expect(block).not.toContain("d60,");
    expect(block).not.toContain(" d60 ");
    expect(block).toContain("(+40 more)");
  });
});

import { collectProjectContext, partitionRuleFiles } from "./agentContext.js";

const fakeSha = async (s) => `hash:${s}`; // deterministic fake

describe("collectProjectContext", () => {
  const okInvoke = async (cmd, args) => {
    if (cmd === "collect_rule_files") return [{ name: "AGENTS.md", path: `${args.cwd}\\AGENTS.md`, content: "r", truncated: false }];
    if (cmd === "git_branch_status") return { branch: "main", dirty: true };
    if (cmd === "read_npm_scripts") return ["dev"];
    if (cmd === "list_directory") return ["C:\\p", [{ name: "src", path: "C:\\p\\src", is_dir: true, size: 0, mtime: null }, { name: "a.txt", path: "C:\\p\\a.txt", is_dir: false, size: 1, mtime: null }]];
    throw new Error(`unexpected ${cmd}`);
  };

  it("collects rule files (with content hash) + real-shaped facts", async () => {
    const got = await collectProjectContext({ cwd: "C:\\p", invoke: okInvoke, sha256: fakeSha });
    expect(got.ruleFiles).toHaveLength(1);
    expect(got.ruleFiles[0].hash).toBe("hash:r");
    expect(got.facts.git).toEqual({ branch: "main", dirty: true });
    expect(got.facts.dirs).toEqual(["src"]); // is_dir, snake_case
    expect(got.facts.npmScripts).toEqual(["dev"]);
  });

  it("null or empty cwd -> empty result, zero invokes", async () => {
    let called = 0;
    const spy = async () => { called++; return null; };
    expect(await collectProjectContext({ cwd: null, invoke: spy, sha256: fakeSha })).toEqual({ ruleFiles: [], facts: null });
    expect(await collectProjectContext({ cwd: "", invoke: spy, sha256: fakeSha })).toEqual({ ruleFiles: [], facts: null });
    expect(called).toBe(0);
  });

  it("individual command failure degrades to partial facts", async () => {
    const flaky = async (cmd, args) => {
      if (cmd === "git_branch_status") throw new Error("no git");
      return okInvoke(cmd, args);
    };
    const got = await collectProjectContext({ cwd: "C:\\p", invoke: flaky, sha256: fakeSha });
    expect(got.facts.git).toBeNull();
    expect(got.ruleFiles).toHaveLength(1);
  });
});

describe("partitionRuleFiles", () => {
  const rf = (path, hash) => ({ name: "AGENTS.md", path, content: "c", truncated: false, hash });

  it("splits approved (hash matches) from pending (new or changed), case-insensitive keys", () => {
    const files = [rf("C:\\a", "h1"), rf("C:\\b", "h2"), rf("C:\\c", "h3")];
    // Map keys are stored lowercased; files arrive with canonicalize's casing.
    const approvedMap = { "c:\\a": "h1", "c:\\b": "OLD" }; // b changed, c never seen
    const { approved, pending } = partitionRuleFiles(files, approvedMap);
    expect(approved.map((f) => f.path)).toEqual(["C:\\a"]);
    expect(pending.map((f) => f.path)).toEqual(["C:\\b", "C:\\c"]);
  });

  it("no approval map -> everything pending", () => {
    const { approved, pending } = partitionRuleFiles([rf("C:\\a", "h1")], undefined);
    expect(approved).toEqual([]);
    expect(pending).toHaveLength(1);
  });
});

// Release-audit pin: masking must happen BEFORE the budget cut. The old call
// site (assemble+cut, then scan) let a secret straddling the cut boundary
// survive as an unmatchable raw fragment in the text sent to the LLM.
describe("buildSafeContextBlock — masks before the budget cut", () => {
  const KEY = "AKIAABCDEFGHIJKLMNOP"; // 20 chars, matches the aws-access-key pattern

  const mkInput = (pos) => ({
    globalRules: "",
    ruleFiles: [
      {
        name: "CLAUDE.md",
        path: "C:\\p\\CLAUDE.md",
        // filler + newline-bounded key (the aws pattern is \b-anchored) +
        // enough tail that the budget cut lands in this file
        content: "x".repeat(pos) + "\n" + KEY + "\n" + "y".repeat(CONTEXT_BUDGET),
        truncated: false,
      },
    ],
    facts: null,
  });

  it("a secret straddling the cut boundary never ships partially unmasked", () => {
    // Self-calibrating: slide the key until the OLD ordering demonstrably
    // leaks a raw "AKIA…" fragment — proving this exact input is the failure
    // case — then require the new API to leak nothing on that same input.
    let leakInput = null;
    for (let pos = CONTEXT_BUDGET - 600; pos < CONTEXT_BUDGET + 200; pos += 1) {
      const input = mkInput(pos);
      const cut = buildContextBlock(input);
      const oldOrder = maskSecrets(cut, scanSecrets(cut));
      if (/AKIA[A-Z]*/.test(oldOrder)) {
        leakInput = input;
        break;
      }
    }
    expect(leakInput).not.toBeNull(); // the old ordering IS leaky on this construction

    const { text, hits } = buildSafeContextBlock(leakInput);
    expect(text).not.toMatch(/AKIA/); // no raw fragment survives, boundary or not
    expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET); // hard cap still holds
    expect(hits.some((h) => h.match === KEY)).toBe(true); // the key was seen + counted
  });

  it("secrets inside facts are still masked (post-assembly scan)", () => {
    const { text } = buildSafeContextBlock({
      globalRules: "",
      ruleFiles: [],
      facts: { cwd: `C:\\p\\${KEY}`, git: null, dirs: null, npmScripts: [] },
    });
    expect(text).not.toContain(KEY);
    expect(text).toContain("[masked");
  });

  it("returns empty text for empty input like buildContextBlock", () => {
    const { text, hits } = buildSafeContextBlock({ globalRules: "", ruleFiles: [], facts: null });
    expect(text).toBe("");
    expect(hits).toEqual([]);
  });
});
