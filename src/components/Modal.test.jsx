// (C)
// @vitest-environment happy-dom
// The shared Modal's focus and backdrop behaviour (v0.7.6 lint fix round 1).
//
// Focus: on open, focus moves to the body element marked data-autofocus, else
// the first focusable in the body; on close it returns to whatever held focus
// before the dialog opened. React's autoFocus cannot be used for the first
// step: it fires in the layout phase, before Modal's passive effect records
// the element to restore, so the dialog would "restore" focus to its own
// (unmounted) field and drop it on <body>.
//
// Backdrop: a click closes the dialog only when the press also began on the
// backdrop. A text-selection drag that starts inside the dialog and is
// released over the backdrop fires its click on the overlay (the common
// ancestor) and must not close it.
import { test, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import Modal from "./Modal.jsx";

afterEach(() => cleanup());

function Single() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>trigger</button>
      <Modal open={open} title="t" onClose={() => setOpen(false)}>
        <button onClick={() => setOpen(false)}>first</button>
        <button data-autofocus onClick={() => setOpen(false)}>marked</button>
      </Modal>
    </>
  );
}

test("open focuses the data-autofocus element, close restores the trigger", async () => {
  render(<Single />);
  const trigger = screen.getByText("trigger");
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  expect(document.activeElement).toBe(screen.getByText("marked"));
  await act(async () => { fireEvent.click(screen.getByText("first")); });
  expect(document.activeElement).toBe(trigger);
});

function Unmarked() {
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} title="t" onClose={() => setOpen(false)}>
      <button>one</button>
      <button>two</button>
    </Modal>
  );
}

test("without a mark, the first body focusable still gets focus (not the header close)", async () => {
  render(<Unmarked />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByText("one"));
});

function Nested() {
  const [inner, setInner] = useState(false);
  return (
    <Modal open title="outer" onClose={() => {}}>
      <button onClick={() => setInner(true)}>openInner</button>
      <Modal open={inner} title="inner" onClose={() => setInner(false)}>
        <input aria-label="tok" />
        <input aria-label="secret" data-autofocus />
        <button onClick={() => setInner(false)}>done</button>
      </Modal>
    </Modal>
  );
}

test("a nested dialog focuses its marked field and returns focus to its opener inside the outer dialog", async () => {
  render(<Nested />);
  const opener = screen.getByText("openInner");
  opener.focus();
  await act(async () => { fireEvent.click(opener); });
  expect(document.activeElement).toBe(screen.getByLabelText("secret"));
  await act(async () => { fireEvent.click(screen.getByText("done")); });
  expect(document.activeElement).toBe(opener);
});

function NestedGoneOpener() {
  const [inner, setInner] = useState(false);
  return (
    <Modal open title="outer" onClose={() => {}}>
      {!inner && <button onClick={() => setInner(true)}>openInner</button>}
      <Modal open={inner} title="inner" onClose={() => setInner(false)}>
        <input aria-label="secret" data-autofocus />
        <button onClick={() => setInner(false)}>done</button>
      </Modal>
    </Modal>
  );
}

test("when the opener cannot take focus back, focus stays inside the outer dialog", async () => {
  // McpInstaller's shape: the "+ Agent Mode" button that opened the token
  // prompt is still disabled when the prompt closes, so a browser refuses to
  // refocus it. happy-dom focuses disabled buttons anyway, so the opener here
  // is unmounted instead, which no DOM can refocus.
  render(<NestedGoneOpener />);
  const opener = screen.getByText("openInner");
  opener.focus();
  await act(async () => { fireEvent.click(opener); });
  await act(async () => { fireEvent.click(screen.getByText("done")); });
  const outer = screen.getByRole("dialog", { name: "outer" });
  expect(outer.contains(document.activeElement)).toBe(true);
});

function Closable({ onClose }) {
  return (
    <Modal open title="t" onClose={onClose}>
      <p>body text</p>
    </Modal>
  );
}

test("a drag that starts inside the dialog and ends on the backdrop does not close it", () => {
  let closed = 0;
  const { container } = render(<Closable onClose={() => { closed++; }} />);
  const overlay = container.ownerDocument.querySelector(".phn-modal-overlay");
  fireEvent.mouseDown(screen.getByText("body text"));
  fireEvent.click(overlay);
  expect(closed).toBe(0);
});

test("a press and release on the backdrop closes it", () => {
  let closed = 0;
  const { container } = render(<Closable onClose={() => { closed++; }} />);
  const overlay = container.ownerDocument.querySelector(".phn-modal-overlay");
  fireEvent.mouseDown(overlay);
  fireEvent.click(overlay);
  expect(closed).toBe(1);
});

test("an inside press does not arm a later backdrop click", () => {
  let closed = 0;
  const { container } = render(<Closable onClose={() => { closed++; }} />);
  const overlay = container.ownerDocument.querySelector(".phn-modal-overlay");
  fireEvent.mouseDown(screen.getByText("body text"));
  fireEvent.click(overlay);
  fireEvent.click(overlay); // no fresh press on the backdrop
  expect(closed).toBe(0);
  fireEvent.mouseDown(overlay);
  fireEvent.click(overlay);
  expect(closed).toBe(1);
});
