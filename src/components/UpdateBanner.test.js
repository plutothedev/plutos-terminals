// (C)
// @vitest-environment happy-dom
// isNewer decides whether the app EVER tells a user an update exists. A false
// negative here means a security fix silently never gets offered, which is the
// exact failure the updater was added to prevent, so it is worth pinning.
//
// The banner-gating block below pins the same guarantee one level up (BRS-2):
// two independent sources write one `latest` slot, and a dismissal recorded
// against whichever tag landed first must never hide a newer verified patch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import UpdateBanner, { isNewer, isDismissed } from "./UpdateBanner.jsx";

const { checkMock, openExternalMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  openExternalMock: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
// openExternal shells out through the Tauri invoke bridge, which does not
// exist here. The Download fallback's destination is the assertion below, so
// the mock has to be the real seam, not a stub nobody reads.
vi.mock("../appMeta.js", () => ({ openExternal: openExternalMock }));

const CACHE_KEY = "plutos-terminals:update-check";
const DISMISS_KEY = "plutos-terminals:dismissed-update";

describe("isNewer", () => {
  it("detects a newer release across each position", () => {
    expect(isNewer("v0.6.1", "0.6.0")).toBe(true);
    expect(isNewer("v0.7.0", "0.6.9")).toBe(true);
    expect(isNewer("v1.0.0", "0.99.99")).toBe(true);
  });

  it("does not offer an update for same or older", () => {
    expect(isNewer("v0.6.0", "0.6.0")).toBe(false);
    expect(isNewer("v0.5.9", "0.6.0")).toBe(false);
    expect(isNewer("v0.6.0", "0.6.1")).toBe(false);
  });

  it("tolerates a missing or present leading v on either side", () => {
    expect(isNewer("0.6.1", "v0.6.0")).toBe(true);
    expect(isNewer("v0.6.1", "v0.6.0")).toBe(true);
  });

  it("treats a shorter version as zero-padded, not as newer", () => {
    // 0.6 vs 0.6.0 are equal; 0.6.1 vs 0.6 is newer.
    expect(isNewer("v0.6", "0.6.0")).toBe(false);
    expect(isNewer("v0.6.1", "0.6")).toBe(true);
  });

  it("never fires on unparseable tags (no false update banner)", () => {
    for (const junk of ["nightly", "v", "", null, undefined, "vX.Y.Z", "latest"]) {
      expect(isNewer(junk, "0.6.0")).toBe(false);
    }
  });

  it("does not throw on non-string input from a corrupt cache or API", () => {
    for (const junk of [42, {}, [], true, null, undefined]) {
      expect(() => isNewer(junk, "0.6.0")).not.toThrow();
      expect(() => isNewer("v9.9.9", junk)).not.toThrow();
    }
  });
});

describe("isDismissed", () => {
  it("covers the exact version that was dismissed, v-prefix or not", () => {
    expect(isDismissed("v0.6.2", "v0.6.2")).toBe(true);
    expect(isDismissed("0.6.2", "v0.6.2")).toBe(true);
    expect(isDismissed("v0.6.2", "0.6.2")).toBe(true);
  });

  it("never covers a newer version (the security-patch case)", () => {
    expect(isDismissed("v0.6.2", "v0.6.3")).toBe(false);
    expect(isDismissed("v0.6.2", "v0.7.0")).toBe(false);
    expect(isDismissed("v0.6.2", "v1.0.0")).toBe(false);
  });

  it("covers an older offer, so a stale second source cannot re-nag", () => {
    expect(isDismissed("v0.6.3", "v0.6.2")).toBe(true);
  });

  it("treats an absent or unparseable dismissal as covering nothing", () => {
    // A corrupt localStorage value must not be able to silence the banner
    // permanently, which is what a bare `!isNewer(offered, dismissed)` would do.
    for (const junk of ["", null, undefined, "nightly", "latest", "garbage", {}]) {
      expect(isDismissed(junk, "v0.6.3")).toBe(false);
    }
  });

  it("treats a digit-leading dismissal that is not a version as covering nothing", () => {
    // A first-character digit check is not a version check. Each of these
    // parses as an enormous major number ("2026-08-21-hotfix" splits to 2026,
    // "0.6.x" to 0.6.NaN), so nothing is ever newer than them and the
    // dismissal covered EVERY future release, forever. That is BRS-2 made
    // permanent instead of 24h, off one Later click.
    for (const junk of ["2026-08-21-hotfix", "99garbage", "20260821", "0.6.x"]) {
      expect(isDismissed(junk, "v0.6.4")).toBe(false);
    }
  });

  it("treats a dotted-numeric value that is not a release of this app as covering nothing", () => {
    // What the guard above does NOT catch is junk that is dot-separated
    // numerics: a dotted date, or a field wide enough that no real release will
    // ever outrank it. Each reads as newer than everything, forever, so
    // honouring it turns one Later click into a permanent blackout of the
    // banner, a signed security patch included. Same failure as the dashed
    // date, reached through the part of the guard that was still open.
    for (const junk of ["2026.08.21", "0.99999.0", "99999.9", "20260821.0"]) {
      expect(isDismissed(junk, "v0.6.4")).toBe(false);
      expect(isDismissed(junk, "v1.0.0")).toBe(false);
    }
    // Failing open here must not cost the Later button its one job: the
    // verbatim match is checked before any of this reasoning is reached.
    expect(isDismissed("2026.08.21", "2026.08.21")).toBe(true);
  });

  it("never covers an offer that is not a comparable version", () => {
    // Mirror image of the same hole: "cannot compare" must not read as
    // "covered". The signed-updater path writes the slot with no isNewer gate
    // and release.yml copies latest.json's version straight off the tag, so a
    // prerelease can reach the banner without the user having declined it.
    expect(isDismissed("v0.6.2", "v0.6.3-rc.1")).toBe(false);
    expect(isDismissed("v0.6.2", "nightly")).toBe(false);
  });

  it("still covers a non-version offer it was taken on verbatim", () => {
    // Failing open on incomparable versions must not cost the Later button its
    // one job: dismissing exactly what is on screen still has to stick.
    expect(isDismissed("v0.6.3-rc.1", "v0.6.3-rc.1")).toBe(true);
    expect(isDismissed("0.6.3-rc.1", "v0.6.3-rc.1")).toBe(true);
  });
});

// One GitHub-API response shape, enough for the two fields the effect reads.
function apiResponse(tag) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'W/"etag"' },
    json: async () => ({ tag_name: tag, html_url: `https://example.invalid/${tag}` }),
  };
}

function seedCache(tag) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({
    tag, url: `https://example.invalid/${tag}`, checkedAt: Date.now(),
  }));
}

function signedUpdate(version) {
  return { available: true, version, downloadAndInstall: vi.fn() };
}

const mount = (currentVersion = "0.6.1") =>
  render(createElement(UpdateBanner, { currentVersion }));

// Let the async updater effect (dynamic import, then check()) settle. Positive
// assertions use findBy*; negative ones need this plus the checkMock assertion
// above them, or they would pass vacuously by running before the probe lands.
const settle = () => act(async () => { await null; await null; await null; });

beforeEach(() => {
  localStorage.clear();
  checkMock.mockReset();
  checkMock.mockResolvedValue(null);
  openExternalMock.mockReset();
  // Never resolves unless a test replaces it, so the API effect cannot race a
  // test that is only about the signed-updater source.
  globalThis.fetch = vi.fn(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UpdateBanner gating", () => {
  it("shows a newer signed patch even though an older tag was dismissed", async () => {
    // BRS-2: dismiss v0.6.2, then a forced v0.6.3 ships. The API effect is still
    // inside its 24h cache and restores v0.6.2, so the signed updater is the only
    // source that knows about the patch. It must win the slot.
    seedCache("v0.6.2");
    localStorage.setItem(DISMISS_KEY, "v0.6.2");
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    mount();

    expect(await screen.findByText("v0.6.3")).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled(); // cache short-circuit, as designed
    expect(screen.getByRole("button", { name: "Install & restart" })).toBeTruthy();
  });

  it("stays hidden when the dismissed version is the one being offered", async () => {
    seedCache("v0.6.2");
    localStorage.setItem(DISMISS_KEY, "v0.6.3");
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    mount();
    await waitFor(() => expect(checkMock).toHaveBeenCalled());
    await settle();

    expect(screen.queryByText("UPDATE AVAILABLE")).toBeNull();
  });

  it("matches a dismissal that was stored without the leading v", async () => {
    // The two sources spell the same version differently ("v0.6.3" from a tag,
    // "0.6.3" from the updater), so the gate has to compare versions, not strings.
    // The corrupt-dismissal test below is this test's control: same setup, only
    // the stored value differs, and it renders. So a null here is the gate
    // firing, not the updater probe having quietly failed.
    localStorage.setItem(DISMISS_KEY, "0.6.3");
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    mount();
    await waitFor(() => expect(checkMock).toHaveBeenCalled());
    await settle();

    expect(screen.queryByText("UPDATE AVAILABLE")).toBeNull();
  });

  it("still shows the banner when the stored dismissal is corrupt", async () => {
    localStorage.setItem(DISMISS_KEY, "garbage");
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    mount();

    expect(await screen.findByText("v0.6.3")).toBeTruthy();
  });

  it("still shows the banner when the stored dismissal is digit-leading junk", async () => {
    // The test above only covered junk starting with a letter, which is why a
    // first-character guard looked sufficient. Anything starting with a digit
    // blacked the banner out permanently instead, including a signed security
    // patch, with no expiry and no signal to the user.
    localStorage.setItem(DISMISS_KEY, "2026-08-21-hotfix");
    checkMock.mockResolvedValue(signedUpdate("0.6.4"));

    mount();

    expect(await screen.findByText("v0.6.4")).toBeTruthy();
  });

  it("still shows the banner when the stored dismissal is a dotted date", async () => {
    // The dashed form above never reached the version gate; this one does, and
    // used to pass it. A single Later click on a mistagged release then hid
    // every future update for good, with no expiry and no signal to the user.
    localStorage.setItem(DISMISS_KEY, "2026.08.21");
    checkMock.mockResolvedValue(signedUpdate("0.6.4"));

    mount();

    expect(await screen.findByText("v0.6.4")).toBeTruthy();
  });

  it("keeps the release-specific url when both sources report the same version", async () => {
    // Only the API path knows the release's own page; the updater always
    // carries the releases index. On a cold cache the two race, and a tie used
    // to go to whoever wrote first, stranding the Download fallback on the
    // index after a failed in-place install.
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((res) => { resolveFetch = res; }));
    const failing = signedUpdate("0.6.3");
    failing.downloadAndInstall = vi.fn().mockRejectedValue(new Error("binary locked"));
    checkMock.mockResolvedValue(failing);

    mount();
    expect(await screen.findByText("v0.6.3")).toBeTruthy();
    await act(async () => { resolveFetch(apiResponse("v0.6.3")); });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Install & restart" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));

    expect(openExternalMock).toHaveBeenCalledWith("https://example.invalid/v0.6.3");
  });

  it("offers a plain download when the signed payload is older than the tag on offer", async () => {
    // latest.json can lag the GitHub release (see BRS-7). "Install & restart"
    // there would hand back a build older than the one the banner names and
    // re-offer itself forever, so the honest answer is the download link.
    seedCache("v0.7.0");
    checkMock.mockResolvedValue(signedUpdate("0.6.9"));

    mount();
    await waitFor(() => expect(checkMock).toHaveBeenCalled());
    await settle();

    expect(screen.getByText("v0.7.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("does not let a late API answer clobber a newer signed offer", async () => {
    // Ordering between the two sources is not ours to control: the fetch can
    // land after the updater probe. Whichever knows the higher version owns the
    // slot regardless of who answered last.
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((res) => { resolveFetch = res; }));
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    mount();
    expect(await screen.findByText("v0.6.3")).toBeTruthy();

    await act(async () => { resolveFetch(apiResponse("v0.6.2")); });
    await settle();

    expect(screen.getByText("v0.6.3")).toBeTruthy();
    expect(screen.queryByText("v0.6.2")).toBeNull();
  });

  it("does not let a 304 revalidation clobber a newer signed offer", async () => {
    // Past the 24h gate the check revalidates with If-None-Match, and a 304
    // restores the CACHED tag rather than a fresh one. That write lands late,
    // after the signed updater has already put a newer version in the slot, so
    // it has to merge like every other writer instead of winning by being last.
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      tag: "v0.6.2",
      url: "https://example.invalid/v0.6.2",
      etag: 'W/"cached"',
      checkedAt: Date.now() - 25 * 60 * 60 * 1000,
    }));
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((res) => { resolveFetch = res; }));
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    mount();
    expect(await screen.findByText("v0.6.3")).toBeTruthy();
    // Proves the 304 branch is reached for the right reason and not by luck.
    expect(globalThis.fetch.mock.calls[0][1].headers["If-None-Match"]).toBe('W/"cached"');

    await act(async () => { resolveFetch({ status: 304, ok: false }); });
    await settle();

    expect(screen.getByText("v0.6.3")).toBeTruthy();
    expect(screen.queryByText("v0.6.2")).toBeNull();
  });

  it("does not let a re-run of the API check walk the banner back to the cached tag", async () => {
    // The API check keys on currentVersion, so it can run a second time while a
    // newer signed offer already owns the slot. Its 24h-cache branch is the one
    // writer that normally lands first and so never has to merge; when it does
    // not land first, it still must not win by being last.
    seedCache("v0.6.2");
    checkMock.mockResolvedValue(signedUpdate("0.6.3"));

    const view = mount("0.6.0");
    expect(await screen.findByText("v0.6.3")).toBeTruthy();

    await act(async () => {
      view.rerender(createElement(UpdateBanner, { currentVersion: "0.6.1" }));
    });
    await settle();

    expect(screen.getByText("v0.6.3")).toBeTruthy();
    expect(screen.queryByText("v0.6.2")).toBeNull();
  });

  it("keeps the API-only path intact when no signed update exists", async () => {
    // No cache, no signed update: the plain notifier still has to work, and
    // dismissing it still has to persist and hide the banner.
    checkMock.mockRejectedValue(new Error("no updater in a browser build"));
    globalThis.fetch = vi.fn(async () => apiResponse("v0.6.3"));

    mount();

    expect(await screen.findByText("v0.6.3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(screen.queryByText("UPDATE AVAILABLE")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("v0.6.3");
  });

  // Control for the test above: identical setup minus the dismissal, which
  // renders. A null here therefore means the gate fired, not that the fetch
  // never landed.
  it("keeps the API-only path hidden once its own tag is dismissed", async () => {
    checkMock.mockRejectedValue(new Error("no updater in a browser build"));
    globalThis.fetch = vi.fn(async () => apiResponse("v0.6.3"));
    localStorage.setItem(DISMISS_KEY, "v0.6.3");

    mount();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await settle();

    expect(screen.queryByText("UPDATE AVAILABLE")).toBeNull();
  });
});
