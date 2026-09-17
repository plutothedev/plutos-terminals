// (C)
// @vitest-environment happy-dom
// "Reset layout & reload" is the crash escape hatch: it clears ONLY the
// per-window layout key so a poisoned persisted blob cannot loop blank ->
// reload -> blank. Boot recovery treats an absent key as recoverable and
// consults store.json, which still holds that same poisoned blob (the mirror
// wrote it before the crash), so without a mark the reloaded app would restore
// the very layout that just crashed it. Recovery is silent by design, so the
// user would not even be asked: the loop would just come back.
//
// The mark names ONE layout (a fingerprint of the blob being thrown away) rather
// than saying "do not recover". A blanket mark also suppressed the backup READ,
// and with it the mirror hold, so the boot migrations' first flush replaced
// store.json with their defaults ~200 ms later: the crash hatch quietly took the
// user's durable backup with it.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { takeDiscardedLayout } from "../features/terminals/storageKeys.js";
import { layoutFingerprint } from "../features/terminals/workspaceBoot.js";

const KEY = "plutos-terminals:state:v0";
const BLOB = '{"terminalsState":{"panels":[1]}}';

function Boom() {
  throw new Error("poisoned layout");
}

let reloadSpy;
let errSpy;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // happy-dom's reload would try to navigate; the boundary only cares that it
  // was called.
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: reloadSpy },
  });
  // React logs the caught render error; keep the suite output readable.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  errSpy.mockRestore();
});

describe("ErrorBoundary reset-layout escape hatch", () => {
  test("clears the window layout key and reloads", () => {
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Reset layout/));
    expect(localStorage.getItem(KEY)).toBe(null);
    expect(reloadSpy).toHaveBeenCalled();
  });

  test("marks the discard so the next boot does not offer the crashing blob back", () => {
    localStorage.setItem(KEY, BLOB);
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Reset layout/));
    expect(takeDiscardedLayout()).toBe(layoutFingerprint(BLOB));
  });

  test("the mark names THIS layout, so a different backup is still recoverable", () => {
    // The fingerprint is read before the key is removed. Without it the mark is
    // a blanket do-not-recover and store.json goes with the crash.
    localStorage.setItem(KEY, BLOB);
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Reset layout/));
    expect(takeDiscardedLayout()).not.toBe(layoutFingerprint('{"terminalsState":{"panels":[2]}}'));
  });

  test("a layout that was already unusable leaves no mark to match", () => {
    // Nothing to recognise, and an unusable local blob is not what crashed the
    // render anyway. Boot falls back to its ordinary recovery.
    localStorage.setItem(KEY, '{"terminalsState":[');
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Reset layout/));
    expect(localStorage.getItem(KEY)).toBe(null);
    expect(takeDiscardedLayout()).toBe(null);
  });

  test("the mark is one-shot: a later ordinary boot can still recover", () => {
    localStorage.setItem(KEY, BLOB);
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Reset layout/));
    expect(takeDiscardedLayout()).toBe(layoutFingerprint(BLOB));
    expect(takeDiscardedLayout()).toBe(null);
  });

  test("the settings wipe marks the discard too: it clears the same layout key", () => {
    // resetAll is the "still blank after both of those" last resort and it
    // removes the SAME per-window key, so without the mark it restores the same
    // crashing layout out of store.json, on the escape hatch of last resort.
    // Two clicks, because the wipe is armed first.
    localStorage.setItem(KEY, BLOB);
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Clear all settings/));
    fireEvent.click(screen.getByText(/Click again to erase/));
    expect(localStorage.getItem(KEY)).toBe(null);
    expect(takeDiscardedLayout()).toBe(layoutFingerprint(BLOB));
  });

  test("arming the wipe alone changes nothing on disk", () => {
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText(/Clear all settings/));
    expect(localStorage.getItem(KEY)).not.toBe(null);
    expect(takeDiscardedLayout()).toBe(null);
  });

  test("an ordinary crash screen with no reset marks nothing", () => {
    render(<ErrorBoundary storageKey={KEY}><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByText("Reload"));
    expect(takeDiscardedLayout()).toBe(null);
  });
});
