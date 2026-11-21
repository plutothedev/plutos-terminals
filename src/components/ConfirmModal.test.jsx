// (C)
// @vitest-environment happy-dom
// ConfirmModal focus (v0.7.6 lint fix round 1): the default button gets focus
// on open (Confirm normally, Cancel for a destructive confirm so a stray Enter
// cannot reset a workspace), and closing returns focus to the trigger.
import { test, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useEffect, useState } from "react";
import { ConfirmProvider, useConfirm } from "./ConfirmModal.jsx";

afterEach(() => cleanup());

const answers = [];
function Trigger({ destructive }) {
  const confirm = useConfirm();
  return (
    <button onClick={async () => { answers.push(await confirm("sure?", { destructive })); }}>
      trigger
    </button>
  );
}

function mount(destructive) {
  answers.length = 0;
  render(<ConfirmProvider><Trigger destructive={destructive} /></ConfirmProvider>);
  return screen.getByText("trigger");
}

test("Cancel returns focus to the trigger", async () => {
  const trigger = mount(false);
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  await act(async () => { fireEvent.click(screen.getByText("Cancel")); });
  expect(answers).toEqual([false]);
  expect(document.activeElement).toBe(trigger);
});

test("a normal confirm focuses Confirm on open", async () => {
  const trigger = mount(false);
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm" }));
});

test("a destructive confirm focuses Cancel on open", async () => {
  const trigger = mount(true);
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  expect(document.activeElement).toBe(screen.getByText("Cancel"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm" })); });
  expect(answers).toEqual([true]);
  expect(document.activeElement).toBe(trigger);
});

// v0.7.6 lint fix round 2: a caller that awaits one confirm and asks another
// straight away (TerminalsTab's recovered-recording loop) lands both requests
// in one commit, so the dialog never closes between them. Each request still
// gets its own initial focus: a destructive confirm after a normal one opens
// on Cancel, not on the Confirm button the user was just on. When the chain
// ends, focus goes back to the trigger.
function Chain() {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () => {
        answers.push(await confirm("first?"));
        answers.push(await confirm("second?", { destructive: true }));
      }}
    >
      trigger
    </button>
  );
}

// Reproduces a real user click's timing. In a browser, the microtasks queued
// by a user-dispatched click (the caller's `await confirm()` continuation,
// then React's flush) run while window.event is still that click, so React
// gives the caller's next setRequest the click's discrete priority and
// renders it in the same commit as the close: the dialog never closes in
// between. A scripted dispatch in happy-dom leaves window.event undefined,
// the next request gets default priority, and React commits the close and
// the reopen separately, which hides the bug. So window.event is held on the
// click while the continuation runs, and the dispatch is native (fireEvent
// wraps its own act and would flush the close before the continuation).
async function resolveWith(label) {
  const button = label === "Confirm"
    ? screen.getByRole("button", { name: "Confirm" })
    : screen.getByText(label);
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  const had = Object.getOwnPropertyDescriptor(window, "event");
  Object.defineProperty(window, "event", { value: ev, configurable: true, writable: true });
  try {
    await act(async () => {
      button.dispatchEvent(ev);
      for (let i = 0; i < 5; i++) await Promise.resolve(); // the caller's continuation
    });
  } finally {
    if (had) Object.defineProperty(window, "event", had);
    else delete window.event;
  }
}

test("back-to-back confirms each get their own initial focus; the chain ends on the trigger", async () => {
  answers.length = 0;
  render(<ConfirmProvider><Chain /></ConfirmProvider>);
  const trigger = screen.getByText("trigger");
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm" }));
  await resolveWith("Cancel");
  expect(answers).toEqual([false]);
  expect(screen.getByText("second?")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByText("Cancel"));
  await resolveWith("Cancel");
  expect(answers).toEqual([false, false]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

// The recovered-recording loop's shape: the user Tabs to Discard and presses
// it; the next recording's confirm must open on Save (its default), not keep
// focus on Discard where a second Enter would discard that one too.
function Loop() {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () => {
        for (const name of ["a", "b"]) {
          answers.push(await confirm(`recover ${name}?`, { confirmLabel: "Save", cancelLabel: "Discard" }));
        }
      }}
    >
      trigger
    </button>
  );
}

test("a confirm asked right after one answered from its Cancel button opens on its default", async () => {
  answers.length = 0;
  render(<ConfirmProvider><Loop /></ConfirmProvider>);
  const trigger = screen.getByText("trigger");
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  act(() => { screen.getByText("Discard").focus(); });
  await resolveWith("Discard");
  expect(answers).toEqual([false]);
  expect(screen.getByText("recover b?")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  await resolveWith("Discard");
  expect(document.activeElement).toBe(trigger);
});

// v0.7.6 fix round 4: a confirm() asked while one is still open (a guarded
// close or Reset workspace fired from a global shortcut while a confirm is up)
// waits its turn. Round 3 answered the open one false to make room, but the
// recovered-recording loop reads false as "discard", so a shortcut deleted a
// recording the user never answered for. Now the open request stays on screen
// and pending until the user answers it, then the next one shows.
let confirmFn = null;
function Grab() {
  const confirm = useConfirm();
  useEffect(() => { confirmFn = confirm; }, [confirm]);
  return null;
}

// Settles to the promise's value, or "pending" if it has not settled yet.
const settledOf = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), 30))]);

test("a confirm asked while another is open waits; the first stays shown and pending until answered", async () => {
  render(<ConfirmProvider><Grab /></ConfirmProvider>);
  let first, second;
  await act(async () => { first = confirmFn("first?"); });
  expect(screen.getByText("first?")).toBeTruthy();
  await act(async () => { second = confirmFn("second?"); });
  expect(await settledOf(first)).toBe("pending");
  expect(screen.getByText("first?")).toBeTruthy();
  expect(screen.queryByText("second?")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm" })); });
  expect(await first).toBe(true);
  expect(await settledOf(second)).toBe("pending");
  expect(screen.getByText("second?")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByText("Cancel")); });
  expect(await second).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
});

// The reviewer's case: the recovered-recording loop is showing "recover a?"
// when a shortcut fires a guarded close's confirm. The recording must not be
// discarded on the user's behalf, and the loop's next confirm must not jump
// ahead of the dialog the shortcut opened.
test("recovery loop: a shortcut's confirm queues behind the recovery prompt and neither is answered for the user", async () => {
  answers.length = 0;
  render(<ConfirmProvider><Grab /><Loop /></ConfirmProvider>);
  const trigger = screen.getByText("trigger");
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  expect(screen.getByText("recover a?")).toBeTruthy();
  let shortcut;
  await act(async () => {
    shortcut = confirmFn("A remote file has unsaved changes. Continue and discard them?", { confirmLabel: "Discard", destructive: true });
  });
  expect(answers).toEqual([]); // recovery prompt still pending: nothing discarded
  expect(await settledOf(shortcut)).toBe("pending");
  expect(screen.getByText("recover a?")).toBeTruthy();
  await resolveWith("Save");
  expect(answers).toEqual([true]);
  // The shortcut's dialog is next, ahead of the loop's "recover b?".
  expect(screen.getByText(/unsaved changes/)).toBeTruthy();
  expect(screen.queryByText("recover b?")).toBeNull();
  expect(await settledOf(shortcut)).toBe("pending");
  await resolveWith("Cancel");
  expect(await shortcut).toBe(false);
  expect(screen.getByText("recover b?")).toBeTruthy();
  expect(answers).toEqual([true]);
  await resolveWith("Save");
  expect(answers).toEqual([true, true]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

// Late-click guard: B is asked outside act (nothing flushed), then the user
// clicks A's Confirm, and a second click lands on A's Cancel before React
// re-renders. A gets the first answer, the late click on a dialog that is no
// longer the one showing does nothing, and B is still pending and shows next.
test("a late click on a dialog that is no longer showing does nothing; the queued request still shows", async () => {
  render(<ConfirmProvider><Grab /></ConfirmProvider>);
  let first;
  await act(async () => { first = confirmFn("first?"); });
  const second = confirmFn("second?");
  const confirmBtn = screen.getByRole("button", { name: "Confirm" });
  const cancelBtn = screen.getByText("Cancel");
  expect(screen.getByText("first?")).toBeTruthy();
  act(() => {
    confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(await first).toBe(true);
  expect(await settledOf(second)).toBe("pending");
  expect(screen.getByText("second?")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm" })); });
  expect(await second).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

// Focus handed back on close must not scroll the opener into view (a trigger
// in a scrolled list or a terminal pane would jump).
test("closing hands focus back to the trigger without scrolling it", async () => {
  const trigger = mount(false);
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  const spy = vi.spyOn(trigger, "focus");
  await act(async () => { fireEvent.click(screen.getByText("Cancel")); });
  expect(document.activeElement).toBe(trigger);
  expect(spy).toHaveBeenCalled();
  for (const call of spy.mock.calls) expect(call[0]).toEqual({ preventScroll: true });
  spy.mockRestore();
});

// v0.7.6 lint fix round 3: the chain's opener is disabled while its work runs,
// so when the first answer swaps dialogs it cannot take focus and the second
// dialog records <body> as where to return. The opener is enabled again before
// the last answer; the chain must still end on it.
function BusyChain() {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          answers.push(await confirm("first?"));
          answers.push(await confirm("second?"));
        }}
      >
        trigger
      </button>
      <button onClick={() => setBusy(false)}>work done</button>
    </>
  );
}

test("a chain whose opener was disabled mid-chain and enabled again ends on the opener", async () => {
  answers.length = 0;
  render(<ConfirmProvider><BusyChain /></ConfirmProvider>);
  const trigger = screen.getByText("trigger");
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  expect(trigger.disabled).toBe(true);
  await resolveWith("Cancel");
  expect(screen.getByText("second?")).toBeTruthy();
  fireEvent.click(screen.getByText("work done"));
  expect(trigger.disabled).toBe(false);
  // From here the only focus() on the trigger is the provider's chain restore
  // (the second dialog recorded <body>): it must not scroll the trigger.
  const spy = vi.spyOn(trigger, "focus");
  await resolveWith("Cancel");
  expect(answers).toEqual([false, false]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(spy).toHaveBeenCalled();
  for (const call of spy.mock.calls) expect(call[0]).toEqual({ preventScroll: true });
  spy.mockRestore();
});
