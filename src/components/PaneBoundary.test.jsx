// (C)
// @vitest-environment happy-dom
// PaneBoundary keeps a render throw inside one surface (audit H3: the app-wide
// boundary's destroyAll() kills every live session). Two additions are pinned
// here. `onError` lets a modal's owner close it after a catch, because a
// fallback rendered outside the dialog sits clipped below the window and
// reads as a dead button. And the fallback follows the skin, because inside
// the Models dialog it renders on a light surface, where the old dark
// literals measured 1.2:1 to 3.1:1 on moba-light.
import { test, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PaneBoundary } from "./ErrorBoundary.jsx";

afterEach(cleanup);

function Boom() {
  throw new Error("row exploded");
}

function quietly(fn) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {}); // React logs caught errors
  try { return fn(); } finally { spy.mockRestore(); }
}

test("onError hears about the catch once, and the fallback replaces only this surface", () => {
  const onError = vi.fn();
  quietly(() => render(
    <div>
      <span>other pane</span>
      <PaneBoundary label="Models" onError={onError}><Boom /></PaneBoundary>
    </div>,
  ));
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].message).toBe("row exploded");
  expect(screen.getByText("Models hit an error.")).toBeTruthy();
  expect(screen.getByText("other pane")).toBeTruthy();
});

test("an onError that throws does not take the boundary down with it", () => {
  quietly(() => render(
    <PaneBoundary label="Models" onError={() => { throw new Error("owner broke"); }}><Boom /></PaneBoundary>,
  ));
  expect(screen.getByText("Models hit an error.")).toBeTruthy();
});

test("the fallback takes its colours from the skin, not dark literals", () => {
  // happy-dom drops any inline style that uses var() (checked: cssText comes
  // back empty), so this reads the source, in the style of ipcContract.test.js
  // and noDashesInCopy.test.js.
  // Under happy-dom import.meta.url is not a file: URL; vitest runs from the
  // repo root, so resolve from there.
  const src = readFileSync(path.join(process.cwd(), "src", "components", "ErrorBoundary.jsx"), "utf8");
  const start = src.indexOf("export class PaneBoundary");
  const block = src.slice(start, src.indexOf("export class ErrorBoundary", start));
  for (const token of ["--phn-notice-error-fg", "--phn-panel-fg", "--phn-surface-bg", "--phn-surface-border"]) {
    expect(block).toContain(`var(${token},`);
  }
  // text-dim is too faint for the note on seven dark skins (2.6:1 to 3.7:1)
  // and text-fg is 4.37:1 on amber; every pane boundary shows this fallback.
  expect(block).not.toContain("var(--phn-text-dim");
  expect(block).not.toContain("var(--phn-text-fg");
  // Every hex colour left in the fallback is a var() fallback, never a bare value.
  const hexes = [...block.matchAll(/#[0-9a-fA-F]{3,6}\b/g)];
  expect(hexes.length).toBeGreaterThan(0);
  for (const m of hexes) {
    expect(block.slice(Math.max(0, m.index - 40), m.index)).toMatch(/var\(--phn-[a-z-]+,\s*$/);
  }
});

test("Try again remounts the surface", () => {
  let explode = true;
  function Flaky() {
    if (explode) throw new Error("once");
    return <span>recovered</span>;
  }
  quietly(() => render(<PaneBoundary label="Models"><Flaky /></PaneBoundary>));
  explode = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("recovered")).toBeTruthy();
});
