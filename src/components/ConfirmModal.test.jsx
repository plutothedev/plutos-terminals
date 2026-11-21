// (C)
// @vitest-environment happy-dom
// ConfirmModal focus (v0.7.6 lint fix round 1): the default button gets focus
// on open (Confirm normally, Cancel for a destructive confirm so a stray Enter
// cannot reset a workspace), and closing returns focus to the trigger.
import { test, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
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
