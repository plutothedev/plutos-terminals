// (C)
import { describe, it, expect } from "vitest";
import { parseBlocks, writeOutput, setFrontmatterTarget, runnableKind } from "./notebookModel.js";

describe("parseBlocks", () => {
  it("prose-only doc has no blocks and empty frontmatter", () => {
    const md = ["# Title", "", "Just some prose. No fences here.", ""].join("\n");
    const { blocks, frontmatter } = parseBlocks(md);
    expect(blocks).toEqual([]);
    expect(frontmatter).toEqual({});
  });

  it("finds a single runnable fence and ignores a non-runnable one", () => {
    const md = [
      "# Notebook",
      "",
      "```sh",
      "echo hi",
      "```",
      "",
      "Some JSON for reference:",
      "",
      "```json",
      '{"a": 1}',
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("sh");
    expect(blocks[0].code.trim()).toBe("echo hi");
    expect(blocks[0].index).toBe(0);
    expect(blocks[0].outputFence).toBeNull();
  });

  it("inline single-backtick code spans in prose are not fences", () => {
    const md = [
      "Run `ls -la` to list files, or `` echo `whoami` `` for a nested example.",
      "",
      "```bash",
      "pwd",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("bash");
    expect(blocks[0].code.trim()).toBe("pwd");
  });

  it("an unterminated fence is skipped, not misparsed as a block", () => {
    const md = ["```sh", "this fence never closes", "", "more prose after"].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toEqual([]);
  });

  it("owns an immediately-following output fence (0 blank lines)", () => {
    const md = [
      "```sh",
      "echo hi",
      "```",
      "```output (2026-07-20 10:00, exit 0)",
      "hi",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].outputFence).not.toBeNull();
    const of = blocks[0].outputFence;
    // Fixture has no trailing newline (last joined element) -- fence ends at EOF.
    expect(md.slice(of.start, of.end)).toBe(
      ["```output (2026-07-20 10:00, exit 0)", "hi", "```"].join("\n")
    );
    expect(of.end).toBe(md.length);
  });

  it("owns an output fence across exactly one blank line", () => {
    const md = [
      "```sh",
      "echo hi",
      "```",
      "",
      "```output (t1, exit 0)",
      "hi",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks[0].outputFence).not.toBeNull();
  });

  it("does NOT own an output fence across two blank lines", () => {
    const md = [
      "```sh",
      "echo hi",
      "```",
      "",
      "",
      "```output (t1, exit 0)",
      "hi",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks[0].outputFence).toBeNull();
  });

  it("does NOT own an output fence when a prose paragraph intervenes", () => {
    const md = [
      "```sh",
      "echo hi",
      "```",
      "",
      "Here is some explanation of what just happened.",
      "",
      "```output (t1, exit 0)",
      "captured text",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].outputFence).toBeNull();
  });

  it("two runnable blocks back-to-back: block 2 is not mistaken for block 1's output", () => {
    const md = ["```sh", "echo one", "```", "```bash", "echo two", "```"].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].index).toBe(0);
    expect(blocks[0].lang).toBe("sh");
    expect(blocks[0].code.trim()).toBe("echo one");
    expect(blocks[0].outputFence).toBeNull();
    expect(blocks[1].index).toBe(1);
    expect(blocks[1].lang).toBe("bash");
    expect(blocks[1].code.trim()).toBe("echo two");
    expect(blocks[1].outputFence).toBeNull();
  });

  it("an output fence immediately after a NON-runnable fence stays untouched", () => {
    const md = [
      "```json",
      '{"a": 1}',
      "```",
      "```output (t1, exit 0)",
      "orphaned, nobody owns this",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toEqual([]); // json isn't runnable, output isn't runnable either
  });

  it("4-plus-backtick fences parse without misparsing an embedded 3-backtick line", () => {
    const md = ["````sh", "echo start", "```", "echo end", "````"].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("sh");
    expect(blocks[0].code).toBe(["echo start", "```", "echo end", ""].join("\n"));
  });

  it('mid-paragraph "```output" text is not treated as a fence (line-anchored scanner)', () => {
    const md = [
      "prefix line",
      "See the ```output marker for details, not a real fence.",
      "```sh",
      "echo hi",
      "```",
    ].join("\n");
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code.trim()).toBe("echo hi");
  });

  it("parses an output fence at EOF with no trailing newline", () => {
    const md = ["```sh", "echo hi", "```", "```output (t1, exit 0)", "hi", "```"].join("\n");
    expect(md.endsWith("\n")).toBe(false);
    const { blocks } = parseBlocks(md);
    expect(blocks[0].outputFence).not.toBeNull();
    expect(blocks[0].outputFence.end).toBe(md.length);
  });

  it("reads targetPane from frontmatter", () => {
    const md = ["---", "targetPane: pane-42", "---", "", "```sh", "echo hi", "```"].join("\n");
    const { frontmatter, blocks } = parseBlocks(md);
    expect(frontmatter.targetPane).toBe("pane-42");
    expect(blocks).toHaveLength(1);
  });

  it("frontmatter is empty when absent", () => {
    const md = ["```sh", "echo hi", "```"].join("\n");
    const { frontmatter } = parseBlocks(md);
    expect(frontmatter).toEqual({});
  });

  it("block start/end span exactly the code fence lines", () => {
    const md = ["prefix", "```sh", "echo hi", "```", "suffix"].join("\n");
    const { blocks } = parseBlocks(md);
    const b = blocks[0];
    expect(md.slice(b.start, b.end)).toBe(["```sh", "echo hi", "```", ""].join("\n"));
  });
});

describe("writeOutput", () => {
  const args = (over = {}) => ({ output: "hi", exit: 0, timestamp: "2026-07-21 09:00", ...over });

  it("inserts a new output fence right after the code fence when none exists", () => {
    const md = ["```sh", "echo hi", "```", "", "trailing prose"].join("\n");
    const out = writeOutput(md, 0, args());
    expect(out).toContain("```output (2026-07-21 09:00, exit 0)");
    expect(out).toContain("hi");
    expect(out).toContain("trailing prose");
    const { blocks } = parseBlocks(out);
    expect(blocks[0].outputFence).not.toBeNull();
  });

  it("replaces an existing owned output fence", () => {
    const md = ["```sh", "echo hi", "```", "```output (old, exit 1)", "OLD OUTPUT", "```", "after"].join("\n");
    const out = writeOutput(md, 0, args({ output: "NEW OUTPUT" }));
    expect(out).not.toContain("OLD OUTPUT");
    expect(out).toContain("NEW OUTPUT");
    expect(out).toContain("exit 0");
    expect(out).toContain("after");
  });

  it("is idempotent: writing the same output twice is byte-identical", () => {
    const md = ["```sh", "echo hi", "```", "", "trailing prose"].join("\n");
    const once = writeOutput(md, 0, args());
    const twice = writeOutput(once, 0, args());
    expect(twice).toBe(once);
  });

  it("never touches text outside the owned fence range (full-document equality on the untouched parts)", () => {
    const md = [
      "# Heading kept intact",
      "",
      "```sh",
      "echo hi",
      "```",
      "",
      "Prose paragraph kept intact, byte for byte.",
    ].join("\n");
    const out = writeOutput(md, 0, args());
    expect(out.startsWith("# Heading kept intact\n\n```sh\necho hi\n```\n")).toBe(true);
    expect(out.endsWith("Prose paragraph kept intact, byte for byte.")).toBe(true);
  });

  it("never touches prose when replacing an existing owned fence", () => {
    const md = [
      "# Heading kept intact",
      "```sh",
      "echo hi",
      "```",
      "```output (old, exit 1)",
      "old",
      "```",
      "Prose paragraph kept intact, byte for byte.",
    ].join("\n");
    const out = writeOutput(md, 0, args());
    expect(out.startsWith("# Heading kept intact\n```sh\necho hi\n```\n")).toBe(true);
    expect(out.endsWith("Prose paragraph kept intact, byte for byte.")).toBe(true);
  });

  it("slices output over 256KB and appends a truncation marker as the last line", () => {
    const big = "x".repeat(300 * 1024);
    const md = ["```sh", "echo hi", "```"].join("\n");
    const out = writeOutput(md, 0, args({ output: big }));
    const { blocks } = parseBlocks(out);
    const of = blocks[0].outputFence;
    const fenceText = out.slice(of.start, of.end);
    // Marker is the last content line, immediately followed by the closing fence.
    expect(fenceText).toContain("[...truncated at 256KB]\n```");
    expect(fenceText).toContain("x".repeat(256 * 1024)); // exactly the 256KB slice survives
    expect(fenceText).not.toContain("x".repeat(300 * 1024)); // the full untruncated run never landed
  });

  it("does not truncate output at or under the 256KB boundary", () => {
    const exact = "y".repeat(256 * 1024);
    const md = ["```sh", "echo hi", "```"].join("\n");
    const out = writeOutput(md, 0, args({ output: exact }));
    expect(out).not.toContain("[...truncated at 256KB]");
    expect(out).toContain(exact);
  });

  it("labels a timed-out run with exit timeout", () => {
    const md = ["```sh", "echo hi", "```"].join("\n");
    const out = writeOutput(md, 0, args({ exit: "timeout" }));
    expect(out).toContain("exit timeout)");
  });

  it("keeps block index correct after an earlier insert shifts later line offsets", () => {
    const md = ["```sh", "echo one", "```", "```bash", "echo two", "```", "tail prose"].join("\n");
    const written = writeOutput(md, 0, args({ output: "one-output" }));
    const { blocks } = parseBlocks(written);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].index).toBe(0);
    expect(blocks[1].index).toBe(1);
    expect(blocks[1].lang).toBe("bash");
    expect(blocks[1].code.trim()).toBe("echo two");
    expect(written).toContain("tail prose");
  });

  it("throws on an out-of-range block index", () => {
    const md = ["no fences here"].join("\n");
    expect(() => writeOutput(md, 0, args())).toThrow();
  });
});

describe("setFrontmatterTarget", () => {
  it("creates frontmatter when absent", () => {
    const md = ["```sh", "echo hi", "```"].join("\n");
    const out = setFrontmatterTarget(md, "pane-7");
    const { frontmatter, blocks } = parseBlocks(out);
    expect(frontmatter.targetPane).toBe("pane-7");
    expect(blocks).toHaveLength(1); // body untouched/still parses
  });

  it("updates an existing targetPane value", () => {
    const md = ["---", "targetPane: pane-1", "---", "", "```sh", "echo hi", "```"].join("\n");
    const out = setFrontmatterTarget(md, "pane-2");
    const { frontmatter } = parseBlocks(out);
    expect(frontmatter.targetPane).toBe("pane-2");
    expect(out).not.toContain("pane-1");
  });

  it("appends targetPane into an existing frontmatter block that lacks it", () => {
    const md = ["---", "title: My Notebook", "---", "", "```sh", "echo hi", "```"].join("\n");
    const out = setFrontmatterTarget(md, "pane-9");
    const { frontmatter } = parseBlocks(out);
    expect(frontmatter.targetPane).toBe("pane-9");
    expect(out).toContain("title: My Notebook"); // untouched sibling key
  });

  it("leaves the body untouched aside from the frontmatter block", () => {
    const md = ["```sh", "echo hi", "```", "", "trailing prose stays put"].join("\n");
    const out = setFrontmatterTarget(md, "pane-1");
    expect(out).toContain("trailing prose stays put");
    expect(out).toContain("echo hi");
  });
});

describe("CRLF tolerance", () => {
  const crlf = (s) => s.replace(/\n/g, "\r\n");

  it("parses a CRLF document (block + owned output)", () => {
    const md = crlf(["```sh", "echo hi", "```", "```output (t1, exit 0)", "hi", "```"].join("\n"));
    const { blocks } = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code.trim()).toBe("echo hi");
    expect(blocks[0].outputFence).not.toBeNull();
  });

  it("writeOutput on a CRLF document preserves CRLF as the dominant line ending", () => {
    const md = crlf(["```sh", "echo hi", "```", "", "trailing prose"].join("\n"));
    const out = writeOutput(md, 0, { output: "hi", exit: 0, timestamp: "t1" });
    expect(out).toContain("\r\n");
    // Every bare LF in the newly written region must be paired with a CR.
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("setFrontmatterTarget on a CRLF document preserves CRLF", () => {
    const md = crlf(["```sh", "echo hi", "```"].join("\n"));
    const out = setFrontmatterTarget(md, "pane-1");
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("runnableKind", () => {
  describe("single", () => {
    it("a lone complete line", () => {
      expect(runnableKind("echo hi", "sh")).toBe("single");
      expect(runnableKind("dir", "cmd")).toBe("single");
      expect(runnableKind("Get-Process", "powershell")).toBe("single");
      expect(runnableKind("Get-Process", "pwsh")).toBe("single");
    });

    it("the same after stripping blanks and sh-family # comments", () => {
      const code = ["", "# a comment explaining the next line", "", "echo hi", ""].join("\n");
      expect(runnableKind(code, "sh")).toBe("single");
      expect(runnableKind(code, "bash")).toBe("single");
    });

    it("a one-line for/do/done stays single (no keyword-balance guard)", () => {
      expect(runnableKind("for i in 1 2 3; do echo $i; done", "sh")).toBe("single");
    });

    it("a one-line cmd backgrounding with a lone trailing & stays single", () => {
      expect(runnableKind("foo &", "cmd")).toBe("single");
    });

    it("cmd/powershell trailing backslash is a path separator, not a continuation", () => {
      expect(runnableKind("cd C:\\Users\\pluto\\", "cmd")).toBe("single");
      expect(runnableKind("cd C:\\Users\\pluto\\", "powershell")).toBe("single");
      expect(runnableKind("cd C:\\Users\\pluto\\", "pwsh")).toBe("single");
    });
  });

  describe("multiline", () => {
    it("any 2+ runnable lines, regardless of shape", () => {
      expect(runnableKind(["echo a", "echo b"].join("\n"), "sh")).toBe("multiline");
      expect(runnableKind(["if true; then", "echo hi", "fi"].join("\n"), "sh")).toBe("multiline");
      expect(runnableKind(["foreach ($x in $y) {", "echo $x", "}"].join("\n"), "powershell")).toBe(
        "multiline"
      );
      expect(runnableKind(["cat file.txt", "grep foo"].join("\n"), "sh")).toBe("multiline");
    });

    it("sh/bash trailing backslash is an incomplete continuation", () => {
      expect(runnableKind("echo foo\\", "sh")).toBe("multiline");
      expect(runnableKind("echo foo\\", "bash")).toBe("multiline");
    });

    it("cmd trailing caret is an incomplete continuation", () => {
      expect(runnableKind("foo ^", "cmd")).toBe("multiline");
    });

    it("powershell/pwsh trailing backtick is an incomplete continuation", () => {
      expect(runnableKind("Get-Item `", "powershell")).toBe("multiline");
      expect(runnableKind("Get-Item `", "pwsh")).toBe("multiline");
    });

    it("a heredoc opener is incomplete regardless of lang", () => {
      expect(runnableKind("cat <<EOF", "sh")).toBe("multiline");
      expect(runnableKind("cat <<EOF", "cmd")).toBe("multiline");
    });

    it("a trailing && is incomplete regardless of lang", () => {
      expect(runnableKind("echo hi &&", "sh")).toBe("multiline");
      expect(runnableKind("echo hi &&", "powershell")).toBe("multiline");
    });

    it("a trailing || is incomplete regardless of lang", () => {
      expect(runnableKind("ls foo ||", "sh")).toBe("multiline");
    });

    it("a bare trailing pipe is incomplete regardless of lang", () => {
      expect(runnableKind("ls |", "sh")).toBe("multiline");
      expect(runnableKind("Get-ChildItem |", "powershell")).toBe("multiline");
    });
  });
});
