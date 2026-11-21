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

test("other keys leave the toast alone", () => {
  mount();
  act(() => { api.info("heads up", { ttl: 0 }); });
  fireEvent.keyDown(screen.getByRole("button", { name: /heads up/ }), { key: "a" });
  expect(screen.getByText("heads up")).toBeTruthy();
});
