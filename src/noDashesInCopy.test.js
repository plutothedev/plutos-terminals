// (C)
// Guard test: no em dash (U+2014) or en dash (U+2013) in user-visible copy.
//
// pluto's standing rule is that nothing he publishes carries an em dash, and
// the app's interface is published surface: titles, tooltips, placeholders,
// toasts, button labels, error strings and JSX text. A 2026-09-19 pass took
// 141 em dashes and 1 en dash out of that copy across 47 files.
//
// tourSteps.test.js already asserted this for the guided-tour strings. This
// widens the same idea to the whole shipped tree, in the source-reading style
// of releaseWorkflow.test.js: read what ships, not a copy of it.
//
// Comments are developer-only and are NOT covered by the rule, so they are
// stripped before the assertion (805 of them carry a dash today). Regex
// literals are stripped too: a pattern that matches a dash is machinery, not
// copy. Test files are excluded because vitest titles never reach a user.
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const EM = "—";
const EN = "–";

// Genuinely non-visible occurrences that must survive, as "<path>:<line>".
// Keep this short and justify every entry. It is empty on purpose: the pass
// found nothing in shipped code that had to keep a dash.
const ALLOW = new Set([]);

// Comment + regex stripper. Built on the scanner in diskGc.test.js (quote- and
// escape-aware, so a `//` inside a string literal is not a comment) with two
// additions that file's KNOWN LIMIT note called out as unsafe here:
//
//   1. Regex literals are tracked. Without this, the backticks inside
//      notebookModel.js's FENCE_OPEN_RE read as a template-literal delimiter
//      and desynchronised every line after it.
//   2. A ' or " string closes at a newline, which is simply what JS does. That
//      makes the scan self-healing over JSX prose, where an apostrophe in
//      "you're" is text and not a quote. Erring here keeps MORE text in the
//      scan, so the failure direction is a false alarm, never a miss.
//
// Replacements are space-for-character so line numbers stay truthful.
export function stripNonCopy(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\n" && quote !== "`") { quote = null; continue; }
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    // An apostrophe glued to a word character is English, not a delimiter.
    if (c === '"' || c === "`" || (c === "'" && !/[\w$)\]]/.test(out[out.length - 1] ?? ""))) {
      quote = c; out += c; continue;
    }
    if (c === "'") { out += c; continue; }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i++;
      continue;
    }
    if (c === "/" && regexStarts(out)) {
      const end = regexEnd(src, i);
      if (end > 0) {
        for (let k = i; k <= end; k++) out += " ";
        i = end;
        continue;
      }
    }
    out += c;
  }
  return { text: out, state: quote };
}

const KEYWORDS = /(?:^|[^\w$.])(?:return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/;

// Deliberately narrow. `}` and a bare `<` are left out because JSX is full of
// `<Foo a={1} />` and `</div>`, and reading either slash as a regex would eat
// the copy that follows it.
function regexStarts(before) {
  const t = before.replace(/[ \t]+$/, "");
  if (t === "") return true;
  const last = t[t.length - 1];
  if (last === "\n") return true;
  if ("(,=:[!&|?;{".includes(last)) return true;
  if (last === ">" && t[t.length - 2] === "=") return true; // arrow body
  return KEYWORDS.test(t);
}

// A regex literal cannot span a line, so refusing to cross one stops a misread
// slash (JSX text like "and/or") from swallowing real copy.
function regexEnd(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\n") return -1;
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "/") return i;
  }
  return -1;
}

function shippedFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { shippedFiles(p, out); continue; }
    if (!/\.(js|jsx)$/.test(name)) continue;
    if (/\.test\.(js|jsx)$/.test(name)) continue;
    out.push(p);
  }
  return out;
}

const FILES = shippedFiles();

// Every dash left in copy, as "<path>:<line>: <source line>".
function findDashes(files) {
  const hits = [];
  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    if (!src.includes(EM) && !src.includes(EN)) continue;
    const { text } = stripNonCopy(src);
    const original = src.split("\n");
    const stripped = text.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      if (!stripped[i].includes(EM) && !stripped[i].includes(EN)) continue;
      if (ALLOW.has(`${rel}:${i + 1}`)) continue;
      hits.push(`${rel}:${i + 1}: ${original[i].trim()}`);
    }
  }
  return hits;
}

describe("no em or en dashes in user-visible copy (pluto rule)", () => {
  test("the tree is scanned at all", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  test("every shipped .js/.jsx file is free of them outside comments", () => {
    expect(findDashes(FILES).join("\n")).toBe("");
  });

  // If the scanner ever ends a file mid-string it has lost the plot, and a
  // desynchronised scan can hide a real dash inside a phantom comment. Fail
  // loudly rather than reporting a clean tree on a broken read.
  test("the scanner parses every file to a balanced end state", () => {
    const broken = FILES
      .filter((f) => stripNonCopy(readFileSync(f, "utf8")).state !== null)
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(broken).toEqual([]);
  });

  test("the allowlist has no stale entries", () => {
    const live = new Set(findDashes(FILES).map((h) => h.split(": ")[0]));
    for (const key of ALLOW) expect(live.has(key), `${key} no longer has a dash`).toBe(false);
  });
});

describe("the stripper the guard depends on", () => {
  const strip = (s) => stripNonCopy(s).text;

  test("drops line, block and trailing comments", () => {
    expect(strip(`// gone ${EM}\nkept1;\n/* also ${EM} gone */\nkept2;`)).not.toContain(EM);
    expect(strip(`// gone\nkept1;\n/* gone */\nkept2;`)).toMatch(/kept1;[\s\S]*kept2;/);
    expect(strip(`doWork(); // harvest ${EM} note\n`)).not.toContain(EM);
  });

  test("KEEPS a dash inside a string literal, which is the whole point", () => {
    expect(strip(`const s = "Copy failed ${EM} retry";`)).toContain(EM);
    expect(strip(`<div>Copy failed ${EM} retry</div>`)).toContain(EM);
    expect(strip(`const s = \`a ${EM} b\`;`)).toContain(EM);
    expect(strip(`const s = 'a ${EN} b';`)).toContain(EN);
  });

  test("a `//` inside a string literal is not a comment", () => {
    expect(strip(`const u = "https://x.dev/y"; const s = "b ${EM} c";`)).toContain(EM);
    expect(strip(`const s = 'a // b';`)).toBe(`const s = 'a // b';`);
  });

  test("strips regex literals, and backticks inside one do not desync the rest", () => {
    expect(strip(`const R = /[${EM}]/;`)).not.toContain(EM);
    const real = `const F = /^ {0,3}(\`{3,})[ \\t]*([^\\s\`]*).*$/;\nconst s = "x ${EM} y";`;
    expect(strip(real)).toContain(EM);
    expect(stripNonCopy(real).state).toBe(null);
  });

  test("JSX survives: apostrophes in prose and self-closing tags", () => {
    const jsx = `<p>you're done</p>\n<Foo a={1} />\n<span>a ${EM} b</span>`;
    expect(stripNonCopy(jsx).state).toBe(null);
    expect(strip(jsx)).toContain(EM);
    expect(strip(`<div>{x}</div>\n<span>and/or ${EM} yes</span>`)).toContain(EM);
  });

  test("line numbers survive stripping", () => {
    const src = `// a\n// b\nconst s = "x ${EM} y";\n`;
    expect(strip(src).split("\n")[2]).toContain(EM);
  });
});
