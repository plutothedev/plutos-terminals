// (C)
// @vitest-environment happy-dom
// Palette "Reset workspace" is single-flight (v0.7.6 audit): confirms queue
// FIFO, so picking it again while its confirm is open stacked a second
// identical "Reset workspace?" behind the first.
import { test, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@backend", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
let answer;
const confirm = vi.fn(() => new Promise((r) => { answer = r; }));
vi.mock("../../../components/ConfirmModal.jsx", () => ({ useConfirm: () => confirm }));

import { usePaletteCommands } from "./usePaletteCommands.jsx";

function resetAction(persist) {
  const noop = () => {};
  const { result } = renderHook(() => usePaletteCommands({
    scOf: () => undefined,
    state: { panels: [{ id: "p1", tabs: [{ id: "t1" }], activeTabId: "t1" }], activePanelId: "p1" },
    persist,
    addTab: noop, addPanel: noop, splitPane: noop, equalizePanes: noop, closePane: noop, importSshConfig: noop,
    switchTab: noop, switchTabRel: noop, selectRibbon: noop, focusFilesDock: noop, openTunnels: noop,
    stopAndSaveRecording: noop, startRecordingActive: noop, setActivePanel: noop, toggleBroadcast: noop,
  }));
  return result.current.find((c) => c.id === "reset-workspace").action;
}

test("Reset workspace picked again while its confirm is open asks once", async () => {
  confirm.mockClear();
  const persist = vi.fn();
  const reset = resetAction(persist);
  const first = reset();
  const second = reset();
  expect(confirm).toHaveBeenCalledTimes(1);
  await second;
  answer(true);
  await first;
  expect(persist).toHaveBeenCalledTimes(1);
  // Free again once answered.
  const third = reset();
  expect(confirm).toHaveBeenCalledTimes(2);
  answer(false);
  await third;
  expect(persist).toHaveBeenCalledTimes(1);
});
