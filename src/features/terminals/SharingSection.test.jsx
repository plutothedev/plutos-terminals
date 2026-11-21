// (C)
// @vitest-environment happy-dom
// SharingSection's unmount guard: a gist auth lookup that answers after the
// settings page closed must set no state. React 18 drops such a set silently,
// so the test records every state setter call made after unmount (useState is
// wrapped for this file only) and expects none.
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const { invokeMock, setterLog } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setterLog: { armed: false, calls: [] },
}));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));
vi.mock("react", async (orig) => {
  const R = await orig();
  // Same state, same stable setter identity; the setter also logs once armed.
  function useState(init) {
    const [value, set] = R.useState(init);
    const ref = R.useRef(null);
    if (ref.current === null) {
      ref.current = (next) => {
        if (setterLog.armed) setterLog.calls.push(next);
        return set(next);
      };
    }
    return [value, ref.current];
  }
  return { ...R, useState };
});

import SharingSection from "./SharingSection.jsx";

afterEach(() => {
  cleanup();
  setterLog.armed = false;
  setterLog.calls = [];
  invokeMock.mockReset();
});

describe("SharingSection unmount guard", () => {
  test("a lookup resolving after unmount sets nothing", async () => {
    let resolve;
    invokeMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { unmount } = render(<SharingSection />);
    expect(invokeMock).toHaveBeenCalledWith("gist_auth_available");
    unmount();
    setterLog.armed = true;
    await act(async () => { resolve({ source: "gh" }); });
    expect(setterLog.calls).toEqual([]);
  });

  test("a lookup failing after unmount sets nothing", async () => {
    let reject;
    invokeMock.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { unmount } = render(<SharingSection />);
    unmount();
    setterLog.armed = true;
    await act(async () => { reject(new Error("keychain locked")); });
    expect(setterLog.calls).toEqual([]);
  });

  test("the setter log does see a live component's lookup (positive control)", async () => {
    let resolve;
    invokeMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<SharingSection />);
    setterLog.armed = true;
    await act(async () => { resolve({ source: "gh" }); });
    expect(setterLog.calls).toContain("gh");
  });
});
