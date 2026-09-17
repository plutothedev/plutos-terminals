// (C)
// @vitest-environment happy-dom
// The Files dock must not put a whole directory listing in the DOM (audit
// PERF-1).
//
// `list_directory`'s backend cap went 5,000 -> 50,000 on 2026-08-16 and nothing
// on the render side changed, so double-clicking into System32 or a
// node_modules tree committed hundreds of thousands of nodes in one synchronous
// pass. These tests render the REAL component against a mocked `@backend` and
// count the rows it actually produced, rather than asserting on the slicing
// helper alone: a helper the component forgot to call would be a test of
// nothing, which is the failure mode this batch exists to remove.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import LocalFileBrowser, { DISPLAY_MAX, listingNotice } from "./LocalFileBrowser.jsx";

const entry = (i) => ({
  name: `file-${String(i).padStart(6, "0")}.txt`,
  path: `/home/pluto/file-${String(i).padStart(6, "0")}.txt`,
  is_dir: false,
  size: 10,
  mtime: 0,
});

/** `list_directory` reply shape: [resolvedPath, entries, wasTruncated]. */
function listing(count, { path = "/home/pluto", fetchTruncated = false } = {}) {
  return [path, Array.from({ length: count }, (_, i) => entry(i)), fetchTruncated];
}

const rows = () => document.querySelectorAll(".phn-sftp-row");

async function mount() {
  const view = render(<LocalFileBrowser />);
  await waitFor(() => expect(invokeMock).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("LocalFileBrowser render cap (PERF-1)", () => {
  test("a small listing renders every row and shows no banner", async () => {
    invokeMock.mockResolvedValue(listing(12));
    await mount();
    expect(rows()).toHaveLength(12);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  test("a huge listing renders at most DISPLAY_MAX rows", async () => {
    // 50,000 is the backend cap exactly: the worst case a user can reach.
    invokeMock.mockResolvedValue(listing(50_000));
    await mount();
    expect(rows()).toHaveLength(DISPLAY_MAX);
    expect(screen.getByText(/Showing 500 of 50,000 entries\./)).toBeTruthy();
  });

  test("the rendered rows are the head of the listing, in order", async () => {
    // Which end is kept is user-visible: the backend sorts, so the head is the
    // alphabetical start. A slice from anywhere else would look like a random
    // sample of the folder.
    invokeMock.mockResolvedValue(listing(1200));
    await mount();
    const names = [...document.querySelectorAll(".phn-sftp-row .name")].map((n) => n.textContent);
    expect(names[0]).toBe("file-000000.txt");
    expect(names[names.length - 1]).toBe(`file-${String(DISPLAY_MAX - 1).padStart(6, "0")}.txt`);
  });

  test("Show more pages in exactly one more DISPLAY_MAX and nothing is unreachable", async () => {
    invokeMock.mockResolvedValue(listing(1200));
    await mount();
    expect(rows()).toHaveLength(DISPLAY_MAX);

    fireEvent.click(screen.getByRole("button", { name: /Show 500 more/ }));
    expect(rows()).toHaveLength(DISPLAY_MAX * 2);
    expect(screen.getByText(/Showing 1,000 of 1,200 entries\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Show 200 more/ }));
    expect(rows()).toHaveLength(1200);
    // Everything is shown, so the banner goes away entirely.
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  test("navigating into another folder resets the cap", async () => {
    // Otherwise a user who paged through one big folder would carry that page
    // size into the next one, which is the unbounded render all over again.
    invokeMock.mockResolvedValue(listing(1200));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /Show 500 more/ }));
    expect(rows()).toHaveLength(DISPLAY_MAX * 2);

    invokeMock.mockResolvedValue(listing(1200, { path: "/home/pluto/other" }));
    fireEvent.click(screen.getByTitle("Home folder"));
    await waitFor(() => expect(rows()).toHaveLength(DISPLAY_MAX));
  });

  test("the fetch cap is still surfaced, and as a floor", async () => {
    // The backend cap breaks out of the read loop BEFORE the sort, so the
    // listing looks complete. The total has to read as "at least this many".
    invokeMock.mockResolvedValue(listing(50_000, { fetchTruncated: true }));
    await mount();
    expect(screen.getByText(/Showing 500 of 50,000\+ entries\./)).toBeTruthy();
  });
});

describe("listingNotice", () => {
  test("says nothing when the listing is complete", () => {
    expect(listingNotice({ shown: 12, fetched: 12, fetchTruncated: false })).toBeNull();
  });

  test("reports the render cap with grouped thousands", () => {
    expect(listingNotice({ shown: 500, fetched: 50_000, fetchTruncated: false })).toBe(
      "Showing 500 of 50,000 entries."
    );
  });

  test("marks the total as a floor when the backend also capped", () => {
    // Without the "+", 50,000 reads as the size of the folder rather than the
    // size of the cap, which is the silent-lie case the banner exists for.
    expect(listingNotice({ shown: 500, fetched: 50_000, fetchTruncated: true })).toBe(
      "Showing 500 of 50,000+ entries."
    );
  });

  test("still warns when everything fetched is shown but the fetch was capped", () => {
    expect(listingNotice({ shown: 300, fetched: 300, fetchTruncated: true })).toBe(
      "Showing 300 of 300+ entries."
    );
  });
});
