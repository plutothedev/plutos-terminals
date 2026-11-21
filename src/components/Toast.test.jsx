// (C)
// @vitest-environment happy-dom
// A toast is dismissed by a click, and (since the v0.7.6 lint pass made it a
// role="button") by Enter or Space from the keyboard. An error toast copies its
// raw detail on either path.
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { ToastProvider, useToast } from "./Toast.jsx";

let api = null;
function Grab() {
  const toast = useToast();
  useEffect(() => { api = toast; }, [toast]);
  return null;
}

afterEach(() => {
  cleanup();
  api = null;
  vi.restoreAllMocks();
});

function mount() {
  render(<ToastProvider><Grab /></ToastProvider>);
}

test("a click dismisses a toast", () => {
  mount();
  act(() => { api.success("saved", { ttl: 0 }); });
  fireEvent.click(screen.getByRole("button", { name: /saved/ }));
  expect(screen.queryByText("saved")).toBeNull();
});

for (const key of ["Enter", " "]) {
  test(`${key === " " ? "Space" : key} dismisses an error toast and copies its detail`, () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    act(() => { api.error({ message: "it broke", detail: "raw stack" }, { ttl: 0 }); });
    const toast = screen.getByRole("button", { name: /it broke/ });
    expect(toast.tabIndex).toBe(0);
    fireEvent.keyDown(toast, { key });
    expect(writeText).toHaveBeenCalledWith("raw stack");
    expect(screen.queryByText("it broke")).toBeNull();
  });
}

// v0.7.6 lint fix round 1: a toast is a Tab stop, so one can hold focus. If it
// auto-dismissed while focused, focus would drop to <body>. The timer pauses
// while the toast has focus and resumes with the time it had left on blur.
test("a focused toast does not auto-dismiss; blur resumes the remaining time", () => {
  vi.useFakeTimers();
  try {
    mount();
    act(() => { api.info("held", { ttl: 1000 }); });
    const toast = screen.getByRole("button", { name: /held/ });
    act(() => { vi.advanceTimersByTime(600); });
    act(() => { toast.focus(); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("held")).toBeTruthy();
    act(() => { toast.blur(); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByText("held")).toBeTruthy(); // 400 ms were left at focus
    act(() => { vi.advanceTimersByTime(150); });
    expect(screen.queryByText("held")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("an unfocused toast still auto-dismisses on its ttl", () => {
  vi.useFakeTimers();
  try {
    mount();
    act(() => { api.success("gone soon", { ttl: 1000 }); });
    act(() => { vi.advanceTimersByTime(999); });
    expect(screen.getByText("gone soon")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.queryByText("gone soon")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("other keys leave the toast alone", () => {
  mount();
  act(() => { api.info("heads up", { ttl: 0 }); });
  fireEvent.keyDown(screen.getByRole("button", { name: /heads up/ }), { key: "a" });
  expect(screen.getByText("heads up")).toBeTruthy();
});

// v0.7.6 lint fix round 2: main.jsx wraps the app in StrictMode, whose dev
// effect cycle runs the provider's cleanup and setup again after the first
// mount. A toast pushed from a child's mount effect is armed before that
// cleanup; it must still auto-dismiss.
function BootToast() {
  const toast = useToast();
  useEffect(() => { toast.info("boot", { ttl: 1000 }); }, [toast]);
  return null;
}

test("under StrictMode a toast pushed from a child's mount effect still auto-dismisses", () => {
  vi.useFakeTimers();
  try {
    render(<StrictMode><ToastProvider><BootToast /></ToastProvider></StrictMode>);
    expect(screen.queryAllByText("boot").length).toBeGreaterThan(0);
    act(() => { vi.advanceTimersByTime(1001); });
    expect(screen.queryAllByText("boot")).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

// v0.7.6 lint fix round 2: a toast dismissed while it has focus hands focus
// back to the element that had it before the toast was focused, instead of
// dropping it on <body>.
function mountWithField() {
  render(
    <ToastProvider>
      <input aria-label="field" />
      <Grab />
    </ToastProvider>,
  );
  return screen.getByLabelText("field");
}

const dismissPaths = {
  Enter: (el) => fireEvent.keyDown(el, { key: "Enter" }),
  Space: (el) => fireEvent.keyDown(el, { key: " " }),
  click: (el) => fireEvent.click(el),
  "api.dismiss": (_el, id) => act(() => { api.dismiss(id); }),
};

for (const [path, run] of Object.entries(dismissPaths)) {
  test(`a focused toast dismissed by ${path} returns focus to where it came from`, () => {
    const field = mountWithField();
    act(() => { field.focus(); });
    let id;
    act(() => { id = api.info("note", { ttl: 0 }); });
    const toast = screen.getByRole("button", { name: /note/ });
    act(() => { toast.focus(); });
    expect(document.activeElement).toBe(toast);
    run(toast, id);
    expect(screen.queryByText("note")).toBeNull();
    expect(document.activeElement).toBe(field);
  });
}

test("moving between toasts keeps the original return target", () => {
  const field = mountWithField();
  act(() => { field.focus(); });
  act(() => { api.info("a", { ttl: 0 }); api.info("b", { ttl: 0 }); });
  const a = screen.getByRole("button", { name: /a$/ });
  const b = screen.getByRole("button", { name: /b$/ });
  act(() => { a.focus(); });
  act(() => { b.focus(); });
  fireEvent.keyDown(b, { key: "Enter" });
  expect(document.activeElement).toBe(field);
});

test("a return target that left the page is not focused", () => {
  function Gone() {
    const [show, setShow] = useState(true);
    return (
      <ToastProvider>
        {show && <input aria-label="field" />}
        <button onClick={() => setShow(false)}>hide</button>
        <Grab />
      </ToastProvider>
    );
  }
  render(<Gone />);
  const field = screen.getByLabelText("field");
  act(() => { field.focus(); });
  act(() => { api.info("note", { ttl: 0 }); });
  const toast = screen.getByRole("button", { name: /note/ });
  act(() => { toast.focus(); });
  fireEvent.click(screen.getByText("hide"));
  expect(field.isConnected).toBe(false);
  fireEvent.keyDown(toast, { key: "Enter" });
  expect(document.activeElement).not.toBe(field);
});

// v0.7.6 lint fix round 3: alt-tabbing away while a toast has focus fires a
// blur with relatedTarget null and document.hasFocus() false, while the toast
// stays the active element. That is not leaving the stack: the toast stays
// paused (it must not vanish while the user is in another window), and on
// return the refocus (relatedTarget null again) must not wipe the return
// target, so a later dismiss still hands focus back to the field.
function windowBlur(toast) {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  fireEvent.focusOut(toast, { relatedTarget: null });
  return hasFocus;
}

test("a focused toast stays paused while the window is away", () => {
  vi.useFakeTimers();
  try {
    mountWithField();
    act(() => { api.info("held", { ttl: 1000 }); });
    const toast = screen.getByRole("button", { name: /held/ });
    act(() => { toast.focus(); });
    act(() => { windowBlur(toast); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("held")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("returning to the window keeps the toast's return target", () => {
  const field = mountWithField();
  act(() => { field.focus(); });
  act(() => { api.info("note", { ttl: 0 }); });
  const toast = screen.getByRole("button", { name: /note/ });
  act(() => { toast.focus(); });
  let hasFocus;
  act(() => { hasFocus = windowBlur(toast); });
  hasFocus.mockReturnValue(true);
  fireEvent.focusIn(toast, { relatedTarget: null });
  fireEvent.keyDown(toast, { key: "Enter" });
  expect(screen.queryByText("note")).toBeNull();
  expect(document.activeElement).toBe(field);
});

// Guard for the window-away rule: a blur with no relatedTarget while the page
// still has focus (a click on an empty, non-focusable area drops focus to
// <body>) does leave the stack, so the toast's timer resumes.
test("focus dropping to <body> inside the page resumes the toast's timer", () => {
  vi.useFakeTimers();
  try {
    mountWithField();
    act(() => { api.info("held", { ttl: 1000 }); });
    const toast = screen.getByRole("button", { name: /held/ });
    act(() => { toast.focus(); });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => { toast.blur(); });
    act(() => { vi.advanceTimersByTime(1001); });
    expect(screen.queryByText("held")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// v0.7.6 lint fix round 3: handing focus back must not scroll the page to
// the return target.
test("the return focus does not scroll", () => {
  const field = mountWithField();
  act(() => { field.focus(); });
  act(() => { api.info("note", { ttl: 0 }); });
  const toast = screen.getByRole("button", { name: /note/ });
  act(() => { toast.focus(); });
  const focus = vi.spyOn(field, "focus");
  fireEvent.keyDown(toast, { key: "Enter" });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});
