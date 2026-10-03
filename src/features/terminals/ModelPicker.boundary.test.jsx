// (C)
// @vitest-environment happy-dom
// A render throw inside the Models picker stays inside the picker. Before the
// picker had its own boundary, a throw in a row (an out-of-range date from a
// provider endpoint did it) reached the app-wide ErrorBoundary, whose
// destroyAll() killed every live terminal and SSH session. The fallback must
// also stay usable: inside the dialog, with the dialog's own close working.
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

vi.mock("@backend", () => ({
  invoke: vi.fn(async () => []),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
// Any row render now throws, standing in for whatever the next bad input is.
vi.mock("./modelCatalog.js", async (importOriginal) => ({
  ...(await importOriginal()),
  pickerList: () => { throw new Error("boom from a row"); },
}));

import ModelPicker from "./ModelPicker.jsx";
import { ToastProvider } from "../../components/Toast.jsx";

afterEach(cleanup);

test("a row that throws shows the fallback inside the dialog, and Close still closes", () => {
  const onClose = vi.fn();
  const spy = vi.spyOn(console, "error").mockImplementation(() => {}); // React logs caught errors
  try {
    render(
      <ToastProvider>
        <ModelPicker open onClose={onClose} userSt={{}} saveUser={() => {}} />
      </ToastProvider>,
    );
  } finally {
    spy.mockRestore();
  }
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Models hit an error.")).toBeTruthy();
  expect(within(dialog).getByText("Your other sessions are unaffected.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  expect(onClose).toHaveBeenCalled();
});
