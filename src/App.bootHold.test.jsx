// (C)
// @vitest-environment happy-dom
// App's boot hold on the durable store.json mirror, mounted for real.
//
// When the primary window boots with no usable layout, App holds the
// store.json mirror until boot recovery has read the backup once. Without the
// hold, the boot migrations' saves are mirrored over store.json ~200 ms later
// and the backup is destroyed before it is read. bootRecovery.test.js pins the
// sequence and the wiring text; this pins the behaviour of the mounted App, so
// a refactor of where the hold is taken (render, initializer, effect) has to
// keep it taking effect before the first flush can reach the mirror.
//
// Also pinned here: the "Storage is full" toast flushNow raises once when the
// layout write throws (it reaches the toast through a ref kept current by an
// effect, not by a render-time write).
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act, screen } from "@testing-library/react";
import { StrictMode } from "react";

const { gate, invokeMock, probe } = vi.hoisted(() => {
  // read_store waits on `gate.open` when a test sets it, as a slow IPC would.
  const gate = { held: null, release: null, gen: 0 };
  const invokeMock = vi.fn(async (cmd) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (cmd === "read_store") {
      if (gate.held) await gate.held;
      return "null"; // no backup file
    }
    if (cmd === "secret_get") return null;
    return null; // write_store and the rest
  });
  const probe = { props: null };
  return { gate, invokeMock, probe };
});

vi.mock("./features/terminals/TerminalsTab.jsx", () => ({
  default: (props) => {
    probe.props = props;
    return null;
  },
}));
vi.mock("./components/UpdateBanner.jsx", () => ({ default: () => null }));

const USER_KEY = "plutos-terminals:user:v0";
const LAYOUT_KEY = "plutos-terminals:state:v0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writes = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "write_store");

async function launch({ layout, strict = false } = {}) {
  localStorage.setItem(USER_KEY, JSON.stringify({ welcomeDone: true }));
  if (layout !== undefined) localStorage.setItem(LAYOUT_KEY, layout);
  vi.resetModules();
  const gen = ++gate.gen;
  vi.doMock("@backend", () => ({
    invoke: (...args) => (gen === gate.gen ? invokeMock(...args) : new Promise(() => {})),
    listen: vi.fn(async () => () => {}),
    isTauri: () => true,
  }));
  const { default: App } = await import("./App.jsx");
  render(strict ? <StrictMode><App /></StrictMode> : <App />);
}

function holdReadStore() {
  gate.held = new Promise((resolve) => { gate.release = resolve; });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  invokeMock.mockClear();
  gate.held = null;
  gate.release = null;
  probe.props = null;
});
afterEach(async () => {
  gate.release?.();
  await act(async () => { await sleep(20); });
  cleanup();
  gate.gen += 1;
  vi.restoreAllMocks();
});

describe("boot with no usable layout holds the store.json mirror until the backup is read", () => {
  for (const strict of [false, true]) {
    test(`nothing is mirrored while read_store is pending, and the held write lands after${strict ? " (StrictMode)" : ""}`, async () => {
      holdReadStore();
      await launch({ strict }); // no layout at all: needsBackupRead
      await waitFor(() => expect(probe.props).not.toBeNull());
      await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === "read_store")).toBe(true));
      // A save the way a boot migration makes one, then well past the 200 ms debounce.
      act(() => probe.props.save((prev) => ({ ...prev, bootHoldProbe: 1 })));
      await act(async () => { await sleep(450); });
      expect(writes()).toEqual([]);
      // localStorage still takes the write: only the durable mirror is held.
      expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)).bootHoldProbe).toBe(1);

      gate.release();
      await waitFor(() => expect(writes().length).toBeGreaterThan(0));
      const last = JSON.parse(writes().at(-1)[1].data);
      expect(last.bootHoldProbe).toBe(1);
    });
  }

  test("control: a layout that parses takes no hold, so the same save is mirrored on the debounce", async () => {
    holdReadStore();
    await launch({ layout: JSON.stringify({ oledDefaultMigrated: true, mobaDefaultForced: true }) });
    await waitFor(() => expect(probe.props).not.toBeNull());
    act(() => probe.props.save((prev) => ({ ...prev, bootHoldProbe: 2 })));
    await act(async () => { await sleep(450); });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "read_store")).toBe(false);
    expect(writes().length).toBeGreaterThan(0);
    expect(JSON.parse(writes().at(-1)[1].data).bootHoldProbe).toBe(2);
  });
});

describe("a layout write the browser refuses", () => {
  test("raises the storage-full toast once, through the toast App holds", async () => {
    await launch({ layout: JSON.stringify({ oledDefaultMigrated: true, mobaDefaultForced: true }) });
    await waitFor(() => expect(probe.props).not.toBeNull());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === LAYOUT_KEY) throw new Error("QuotaExceededError");
      return real(key, value);
    });
    act(() => probe.props.save((prev) => ({ ...prev, quotaProbe: 1 })));
    await act(async () => { await sleep(300); });
    act(() => probe.props.save((prev) => ({ ...prev, quotaProbe: 2 })));
    await act(async () => { await sleep(300); });
    expect(warn).toHaveBeenCalled(); // the write really was refused
    expect(screen.getAllByText(/Storage is full/)).toHaveLength(1);
  });
});
