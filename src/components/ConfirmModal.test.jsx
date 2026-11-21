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
