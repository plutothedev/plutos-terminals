// Auto-update check. On app start, hit the GitHub Releases API for the latest
// release tag, compare to the current bundled version. If a newer version is
// available, show a dismissible banner with a link to the release page.
//
// Failure modes (network down, rate limit, repo deleted, etc.) all silently
// no-op — the banner just doesn't appear.

import { useEffect, useState } from "react";
import { openExternal } from "../appMeta.js";

const REPO_OWNER = "plutothedev";
const REPO_NAME = "plutos-terminals";
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

// Colours here must invert with the skin: the banner paints itself on
// var(--phn-surface-bg), which is #ececec on Light, and hardcoded near-white text
// on that is 1.06:1. This is the surface that tells a user a signed security patch
// is waiting, so unreadable here means undelivered.
//
// All three below are PINNED tokens: the twelve dark blocks carry the exact hex
// this file hardcoded, so the banner is byte-identical on every dark skin, and
// only moba-light and daylight move. The attempt before this reached for the
// nearest semantic token instead, which was worse than the literal it replaced:
// --phn-link is a different colour in ten of the twelve dark skins (#FF0080 on
// neon and magenta, #66ff99 on crt, #ffd966 on amber, #ffffff on brutal), so the
// banner's periwinkle identity became whatever the skin's link colour was, and
// --phn-text-dim did the same to the Later label. Neither shift was asked for,
// and neither closed RV-1: --phn-link is #1170cc on moba-light, which still left
// the UPDATE AVAILABLE label at 4.22:1, under the 4.5:1 floor it owes as 10px
// normal text. --phn-notice-accent is #7c9cf5 on all twelve dark skins and a
// darker blue on the light two, where the label now measures 6.91:1.
const ACCENT = "var(--phn-notice-accent, #7c9cf5)";
const FG_ACTIVE = "var(--phn-ink-soft, #E6E6E6)";
const FG_DIM = "var(--phn-ink-dim, #9D9D9D)";
// Same pinning for the install-error line. #E05B5B is 3.06:1 on moba-light.
const ERROR_FG = "var(--phn-notice-error-fg, #E05B5B)";
// The primary button's FILL stays literal on purpose. White-on-accent only works
// against a dark accent, and --phn-link is near-white in several skins (brutal
// #ffffff, glass, sunset), which would erase the label on the one control that
// installs the update. Retint this only together with its label colour.
const ACCENT_FILL = "#7c9cf5";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// The two sources below spell the same version differently ("v0.6.3" off a
// release tag, "0.6.3" off the updater), so every comparison here normalises
// first and nothing compares tag strings directly.
const stripV = (v) => String(v || "").replace(/^v/, "");

// Compare semver-ish tags ("v0.0.3" or "0.0.3") field by field, left to right,
// with a missing field read as 0. True only when `latest` wins the first field
// the two disagree on.
//
// Two answers, not three: false means "older or equal" AND "could not tell".
// The NaN guard keeps "nightly", "v" and "vX.Y.Z" off the banner, but it only
// fires on a field the loop actually reaches, and a digit-leading tag never gets
// that far: parseInt truncates at the first non-digit ("99garbage" reads as 99)
// and the loop returns at the first difference ("2026-08-21-hotfix" wins on
// major 2026). Both of those read as NEWER than every real release.
//
// The leniency is deliberate rather than a hole to close here, because the offer
// paths still have to compare a suffixed tag like "v0.6.3-rc.1" or a signed
// update ready to install would never be offered at all. Callers that need
// "incomparable" as a third answer gate on `isVersion` below first, which is
// what `isDismissed` does.
export function isNewer(latest, current) {
  const a = stripV(latest).split(/[.-]/);
  const b = stripV(current).split(/[.-]/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = parseInt(a[i] || "0", 10);
    const bi = parseInt(b[i] || "0", 10);
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

// A version this file is willing to REASON about: dot-separated numeric fields
// with an optional leading v. Everything else (a date-stamped tag, a
// prerelease suffix, a bare integer, a corrupt localStorage value) is
// INCOMPARABLE, which is a third answer distinct from newer and older.
// `isNewer` cannot say so on its own because it short-circuits on the first
// field: "2026-08-21-hotfix" compares as major 2026 and beats everything,
// "0.6.x" compares as 0.6.NaN and loses to everything. Both are wrong, and
// both used to reach the dismissal gate below.
//
// Field widths are part of that judgement, not decoration. A release of this
// app is 2 to 4 numeric fields, none of them wider than three digits, so
// "2026.08.21" is a date and "0.99999.0" is a corrupt write. Both are
// dot-separated numerics that outrank every real release forever, so reading
// them as versions let one Later click silence the banner permanently. Bounding
// the shape fails open instead: an implausibly-numbered real release would cost
// one extra banner, which is the cheap direction.
const isVersion = (v) => /^\d{1,3}(\.\d{1,3}){1,3}$/.test(stripV(v));

// Does a stored dismissal cover the version currently on offer? A dismissal
// covers the version it was taken on and anything older, never anything newer:
// the whole point of the banner is that the NEXT release, a forced security
// patch above all, resurfaces it.
export function isDismissed(dismissed, offered) {
  const d = stripV(dismissed);
  const o = stripV(offered);
  if (!d) return false;
  // Dismissing exactly what is on screen always sticks, even for a tag neither
  // side can compare. Keeping this ahead of the version check is what stops
  // failing open below from costing the Later button its one job.
  if (d === o) return true;
  // Incomparable on either side covers nothing. The asymmetry is deliberate: a
  // banner that shows once too often is an annoyance, while one silenced by a
  // value that merely LOOKS like a version hides a signed security patch with
  // no expiry and no signal to the user.
  if (!isVersion(d) || !isVersion(o)) return false;
  return !isNewer(offered, dismissed);
}

// Both effects write the single `latest` slot, and they resolve in an order we
// do not control: the API check short-circuits on its 24h cache and lands
// first, or its fetch lands after the async updater probe. Whichever source
// knows the HIGHER version owns the slot, so the banner always names the newest
// thing actually on offer. Before this, each effect deferred to whoever wrote
// first, and a dismissal recorded against a stale cached tag hid a verified
// security patch for up to 24 hours.
const takeIfNewer = (next) => (cur) => {
  if (!cur || isNewer(next.tag, cur.tag)) return next;
  // Same version, other source. Keep the incumbent, but take the more specific
  // url: the updater only ever carries the releases index, while the API knows
  // the release's own page, and that page is where the Download fallback has to
  // land after a failed in-place install. Whoever answered first is not the one
  // to ask for that.
  if (stripV(cur.tag) === stripV(next.tag) && next.url && next.url !== RELEASES_URL) {
    return { ...cur, url: next.url };
  }
  return cur;
};

export default function UpdateBanner({ currentVersion }) {
  const [latest, setLatest] = useState(null);
  // Set only when the SIGNED updater has a verified update ready to install in
  // place; null means we can offer a manual download and nothing more.
  const [pluginUpdate, setPluginUpdate] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("plutos-terminals:dismissed-update") || "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    let cancelled = false;
    // 24h gate + ETag (P3-T5): this fired an unconditional GitHub API hit on
    // EVERY launch (and twice through the welcome flow / StrictMode), against
    // the same 60/hr unauthenticated budget gist sharing uses. A cached
    // check inside 24h short-circuits entirely; past it, If-None-Match turns
    // an unchanged release into a free 304.
    const CACHE_KEY = "plutos-terminals:update-check";
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { /* ignore */ }
    if (cached && Date.now() - (cached.checkedAt || 0) < 24 * 60 * 60 * 1000) {
      if (cached.tag && isNewer(cached.tag, currentVersion)) {
        setLatest(takeIfNewer({ tag: cached.tag, url: cached.url || RELEASES_URL }));
      }
      return () => { cancelled = true; };
    }
    const headers = { Accept: "application/vnd.github+json" };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    fetch(GITHUB_API, { headers })
      .then(async (r) => {
        if (r.status === 304) {
          // Unchanged release — refresh the clock, keep the cached verdict.
          try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...cached, checkedAt: Date.now() })); } catch { /* ignore */ }
          if (cached?.tag && isNewer(cached.tag, currentVersion) && !cancelled) {
            setLatest(takeIfNewer({ tag: cached.tag, url: cached.url || RELEASES_URL }));
          }
          return null;
        }
        if (!r.ok) return null;
        const data = await r.json();
        const etag = r.headers.get("etag") || undefined;
        if (data?.tag_name) {
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
              tag: data.tag_name, url: data.html_url || RELEASES_URL,
              etag, checkedAt: Date.now(),
            }));
          } catch { /* ignore */ }
        }
        return data;
      })
      .then((data) => {
        if (cancelled || !data || !data.tag_name) return;
        if (isNewer(data.tag_name, currentVersion)) {
          setLatest(takeIfNewer({ tag: data.tag_name, url: data.html_url || RELEASES_URL }));
        }
      })
      .catch(() => { /* network/rate-limit/etc — silently skip */ });
    return () => { cancelled = true; };
  }, [currentVersion]);

  // Signed-updater probe, independent of the GitHub-API check above.
  // The API check is a NOTIFIER (it can only send you to a download page); this
  // one returns an update object that can actually install in place. We run both
  // because they fail differently: the API path still works before latest.json
  // exists on a release, and the updater path still works when the API is
  // rate-limited. Whichever knows the higher version populates the banner; if
  // that is the updater, the primary button installs instead of opening a browser.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const up = await check();
        if (cancelled || !up?.available) return;
        setPluginUpdate(up);
        // The updater is the authoritative offer when it is ahead: it is the
        // only source that can install in place, and unlike the API check it is
        // never served from a 24h cache. It still defers when the API tag is
        // higher, so a release that shipped without updater artifacts is not
        // downgraded away.
        setLatest(takeIfNewer({ tag: `v${up.version}`, url: RELEASES_URL }));
      } catch {
        // Not a Tauri build (browser dev), plugin missing, endpoint 404 before
        // the first updater-enabled release, or signature verification failed.
        // All of these mean "no in-place update offer" — the API notifier above
        // still covers the user.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Gate on the version actually being offered, not on whichever tag happened
  // to land in the slot first: dismissing v0.6.2 must not swallow v0.6.3.
  if (!latest || isDismissed(dismissed, latest.tag)) return null;

  // Offer the in-place install only when the signed updater holds the exact
  // version the banner names. If the API check found something newer than
  // latest.json carries, "Install & restart" would hand back a build older than
  // the one advertised and then re-offer itself on every launch; the download
  // link is the honest answer there.
  const canInstall = !!pluginUpdate && stripV(latest.tag) === stripV(pluginUpdate.version);

  const onInstall = async () => {
    if (!pluginUpdate || installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      // Payload is minisign-verified against the bundled pubkey before anything
      // is written or run — a hostile release asset cannot execute code here.
      // An empty/placeholder pubkey fails this check rather than skipping it.
      await pluginUpdate.downloadAndInstall();
      // NOTE: on Windows this line is unreachable — the plugin's installer path
      // calls process::exit(0) inside downloadAndInstall, so the await never
      // returns and the MSI's own AUTOLAUNCHAPP handles the restart. It matters
      // on macOS, where install returns normally and nothing else relaunches us.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      // Verification failure, partial download, or a locked binary. Say so and
      // leave the manual download button as the way out rather than silently
      // pretending nothing happened.
      setInstalling(false);
      setInstallError(String(e?.message || e || "Update failed"));
    }
  };

  const onDismiss = () => {
    setDismissed(latest.tag);
    try {
      localStorage.setItem("plutos-terminals:dismissed-update", latest.tag);
    } catch { /* ignore */ }
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        background: "var(--phn-surface-bg, #181818)",
        border: `1px solid ${ACCENT}`,
        borderRadius: 6,
        padding: "12px 14px",
        fontFamily: M,
        fontSize: 11,
        color: FG_ACTIVE,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        zIndex: 9980,
        maxWidth: 320,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: ACCENT, fontSize: 10, letterSpacing: 0.5, marginBottom: 6 }}>
        UPDATE AVAILABLE
      </div>
      <div style={{ marginBottom: 10 }}>
        Pluto's Terminal <strong>{latest.tag}</strong> is out (you're on <code style={{ fontSize: 10 }}>v{currentVersion}</code>).
      </div>
      {installError && (
        <div style={{ color: ERROR_FG, fontSize: 10, marginBottom: 8, lineHeight: 1.4 }}>
          Couldn't install automatically: {installError}. Use Download instead.
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={canInstall && !installError ? onInstall : () => openExternal(latest.url)}
          disabled={installing}
          style={{
            background: ACCENT_FILL,
            color: "#fff",
            padding: "5px 12px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 10,
            fontWeight: 600,
            textDecoration: "none",
            cursor: installing ? "default" : "pointer",
            border: "none",
            opacity: installing ? 0.7 : 1,
          }}
        >
          {installing
            ? "Installing…"
            : canInstall && !installError
              ? "Install & restart"
              : "Download"}
        </button>
        <button
          onClick={onDismiss}
          style={{
            background: "transparent",
            // Left literal deliberately. --phn-surface-border is an alpha-white
            // hairline in the dark skins, so tokenising this would visibly dim
            // the outline there to fix a light-skin cosmetic that is not a
            // contrast failure (#2B2B2B on #ececec is ~11:1). Retint it with the
            // rest of the chrome borders, not here.
            border: "1px solid #2B2B2B",
            color: FG_DIM,
            padding: "5px 12px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 10,
            cursor: "pointer",
          }}
        >
          Later
        </button>
      </div>
    </div>
  );
}
