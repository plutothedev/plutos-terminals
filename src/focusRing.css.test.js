// (C)
// Keyboard focus rings: who wins.
//
// The global ring for role="button" spans and divs (src/styles.css) loads AFTER
// the component stylesheets (main.jsx imports App.jsx, which pulls in
// terminals.css, before styles.css). At equal specificity the later rule wins,
// so the global rule written as [role="button"]:focus-visible (0,2,0) beat
// .moba-railcol:focus-visible (0,2,0) and replaced the collapsed rail's 2px
// inset ring with a 1px ring 2px outside, clipped at the window edge. Written
// as :where([role="button"]):focus-visible it is (0,1,0), so every component
// focus rule beats it whatever order the files load in.
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel) => readFileSync(path.join(process.cwd(), rel), "utf8").split(String.fromCharCode(13)).join("");
const stripComments = (t) => {
  let out = "";
  let i = 0;
  for (;;) {
    const a = t.indexOf("/*", i);
    if (a < 0) return out + t.slice(i);
    out += t.slice(i, a);
    const e = t.indexOf("*/", a + 2);
    i = e < 0 ? t.length : e + 2;
  }
};
// [selectors[], declarations] for every plain rule of a stylesheet.
const rulesOf = (rel) => stripComments(read(rel)).split("}").filter((c) => c.includes("{")).map((c) => {
  const at = c.lastIndexOf("{");
  return [c.slice(0, at).split(",").map((s) => s.trim().split(/\s+/).join(" ")), c.slice(at + 1)];
});
const declsFor = (rel, selector) => rulesOf(rel).filter(([sels]) => sels.includes(selector)).map(([, d]) => d).join(";");

describe("the global role=button ring", () => {
  const styles = rulesOf("src/styles.css");
  test("is written with :where, so it carries the specificity of :focus-visible alone", () => {
    const sels = styles.flatMap(([s]) => s);
    expect(sels).toContain(':where([role="button"]):focus-visible');
    expect(sels).not.toContain('[role="button"]:focus-visible');
    expect(declsFor("src/styles.css", ':where([role="button"]):focus-visible')).toContain("outline: 1px solid");
  });
});

describe("component focus rings that must beat it", () => {
  test(".moba-railcol keeps its own 2px inset ring", () => {
    const d = declsFor("src/features/terminals/terminals.css", ".moba-railcol:focus-visible");
    expect(d).toContain("outline: 2px solid");
    expect(d).toContain("outline-offset: -2px");
  });
  test.each([
    ".phn-sidebar .phn-folder-header:focus-visible",
    '.phn-sidebar .phn-session-row[role="button"]:focus-visible',
  ])("%s keeps its inset ring", (sel) => {
    expect(declsFor("src/features/terminals/terminals.css", sel)).toContain("outline-offset: -2px");
  });
});
