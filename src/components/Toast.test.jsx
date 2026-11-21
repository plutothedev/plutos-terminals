// (C)
// @vitest-environment happy-dom
// A toast is dismissed by a click, and (since the v0.7.6 lint pass made it a
// role="button") by Enter or Space from the keyboard. An error toast copies its
// raw detail on either path.
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { useEffect } from "react";
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
