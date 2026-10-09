// (C)
// Every save of the shared user state goes through an updater over the live
// state: saveUser((prev) => ({ ...prev, ... })). The user state carries the
// provider keys, and App mirrors them into the OS keychain on every save,
// where a key missing from the save is a delete. A component that saves
// `{ ...userSt, field }` writes back the copy it last rendered, so a key that
// reached App after that render (the launch load finishing, another window's
// save) was left out and deleted. The Models picker did that for as long as
// it stayed open; the other copies below did it in the gap before a re-render.
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|jsx)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

// `saveUser({ ...userSt` with any spacing, across lines too.
const SHAPE = /saveUser\(\s*\{\s*\.\.\.\s*\(?\s*userSt\b/g;
const offendersIn = (text) => [...text.matchAll(SHAPE)].map((m) => text.slice(0, m.index).split("\n").length);

describe("saveUser is never handed a copy of the rendered user state", () => {
  test("no component spreads userSt into a saveUser call", () => {
    const offenders = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      for (const line of offendersIn(text)) offenders.push(`${path.relative(SRC, file)}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the check itself sees the shape it forbids, wherever the line breaks", () => {
    expect(offendersIn("    saveUser({ ...userSt, keybindings: kb });")).toEqual([1]);
    expect(offendersIn("onDismiss={() => saveUser({...userSt, terminalsOnboarded: true })}")).toEqual([1]);
    expect(offendersIn("saveUser({ ...(userSt || {}), x: 1 })")).toEqual([1]);
    expect(offendersIn("a();\n  saveUser({\n    ...userSt,\n    x: 1,\n  });")).toEqual([2]);
    expect(offendersIn("saveUser((prev) => ({ ...prev, keybindings: kb }));")).toEqual([]);
  });
});
