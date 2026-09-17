// (C)
// @vitest-environment happy-dom
// Factory reset has to clear BOTH copies of the workspace.
//
// store.json (workspaceMirror.js) is a second, durable copy of the window
// layout, and boot recovery reads "localStorage empty + store.json populated"
// as WebView2 profile loss and restores from it. Wiping only localStorage
// therefore left the reset to be undone by the very next launch, while the
// dialog promised to wipe "ALL Pluto's Terminal state from this machine".
//
// The durable half is also the FALLIBLE half (an IPC round-trip to a file
// write), so it goes first: a failure then leaves the app exactly as it was
// instead of half-reset, which is the one state boot recovery cannot reason
// about.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Hoisted so the vi.mock factory (which vitest lifts above the imports) can see
// it without a TDZ error.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import SettingsModal from "./SettingsModal.jsx";
import { localWriteHolds } from "../features/terminals/storageKeys.js";
import { ToastProvider } from "./Toast.jsx";
import { ConfirmProvider } from "./ConfirmModal.jsx";

const KEY = "plutos-terminals:state:v0";

let reloadSpy;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  invokeMock.mockReset();
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: reloadSpy },
  });
});
afterEach(cleanup);

function mount() {
  // No `saveUser`, so the five optional sections stay unrendered: this file is
  // about the reset button, not the settings body.
  render(
    <ToastProvider>
      <ConfirmProvider>
        <SettingsModal open st={{}} save={() => {}} userSt={{}} onClose={() => {}} />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

async function clickReset() {
  fireEvent.click(screen.getByText("Factory reset"));
  fireEvent.click(await screen.findByText("Reset everything"));
}

describe("factory reset", () => {
  test("clears the durable store.json backup, not just localStorage", async () => {
    invokeMock.mockResolvedValue(undefined);
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    mount();
    await clickReset();
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    // "{}" is an empty backup to parseWorkspace, exactly like the "null"
    // sentinel read_store returns when the file is absent.
    expect(invokeMock).toHaveBeenCalledWith("write_store", { data: "{}" });
    expect(localStorage.getItem(KEY)).toBe(null);
  });

  test("clears the durable copy BEFORE the local one", async () => {
    // Reversed, a failed store clear would leave localStorage empty and
    // store.json populated, which is the exact shape boot recovery restores
    // from: the reset would undo itself on the next launch.
    let blobWhenStoreCleared;
    invokeMock.mockImplementation(async () => { blobWhenStoreCleared = localStorage.getItem(KEY); });
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    mount();
    await clickReset();
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(blobWhenStoreCleared).not.toBe(null);
  });

  test("a failed store clear aborts the whole reset and says so", async () => {
    invokeMock.mockRejectedValue(new Error("store.json is read-only"));
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    mount();
    await clickReset();
    await screen.findByText(/on-disk backup/i);
    expect(localStorage.getItem(KEY)).toBe('{"terminalsState":{"panels":[1]}}');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("stops this window re-persisting behind the reset", async () => {
    // The reset clears both copies and reloads, but the reload fires pagehide
    // and beforeunload FIRST, and App.jsx's flush handler still holds the last
    // debounced layout (a theme preview one click earlier is enough). That flush
    // writes localStorage AND mirrors it to store.json, so the window undoes its
    // own factory reset on the way out. Announcing the wipe is what lets the
    // flush stand down; App.jsx's half of the contract is pinned in
    // bootRecovery.test.js ("App.jsx boot wiring").
    const before = localWriteHolds();
    let heldDuringStoreClear;
    invokeMock.mockImplementation(async () => { heldDuringStoreClear = localWriteHolds(); });
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    mount();
    await clickReset();
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    // Up BEFORE the round-trip, which is where the 200 ms debounce would fire
    // and put the layout back into the store.json being cleared. Asserting only
    // the end state would not catch losing this one: wipeAllLocalState takes a
    // hold of its own, so the count after the reset looks the same either way.
    expect(heldDuringStoreClear).toBe(before + 1);
    // Still up after the reset, for the pagehide/beforeunload flush the reload
    // is about to trigger.
    expect(localWriteHolds()).toBe(before + 1);
  });

  test("a failed reset leaves persistence running", async () => {
    // Nothing was wiped, so the window must keep saving exactly as before.
    invokeMock.mockRejectedValue(new Error("store.json is read-only"));
    const before = localWriteHolds();
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    mount();
    await clickReset();
    await screen.findByText(/on-disk backup/i);
    expect(localWriteHolds()).toBe(before);
  });

  test("dismissing the confirm resets nothing at all", async () => {
    localStorage.setItem(KEY, '{"terminalsState":{"panels":[1]}}');
    mount();
    fireEvent.click(screen.getByText("Factory reset"));
    await screen.findByText("Reset everything");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Reset everything")).toBe(null));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe('{"terminalsState":{"panels":[1]}}');
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
