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

const ACCENT_BLUE = "#7c9cf5";
const FG_ACTIVE = "#E6E6E6";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// Compare semver-ish tags ("v0.0.3" or "0.0.3"). Returns true if `latest` is
// newer than `current`. Treats anything unparseable as "not newer" so a weird
// tag never triggers a false update banner.
function isNewer(latest, current) {
  const norm = (v) => String(v || "").replace(/^v/, "").split(/[.-]/);
  const a = norm(latest);
  const b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = parseInt(a[i] || "0", 10);
    const bi = parseInt(b[i] || "0", 10);
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

export default function UpdateBanner({ currentVersion }) {
  const [latest, setLatest] = useState(null);
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
        setLatest({ tag: cached.tag, url: cached.url || RELEASES_URL });
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
            setLatest({ tag: cached.tag, url: cached.url || RELEASES_URL });
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
          setLatest({ tag: data.tag_name, url: data.html_url || RELEASES_URL });
        }
      })
      .catch(() => { /* network/rate-limit/etc — silently skip */ });
    return () => { cancelled = true; };
  }, [currentVersion]);

  if (!latest || dismissed === latest.tag) return null;

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
        border: `1px solid ${ACCENT_BLUE}`,
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
      <div style={{ color: ACCENT_BLUE, fontSize: 10, letterSpacing: 0.5, marginBottom: 6 }}>
        UPDATE AVAILABLE
      </div>
      <div style={{ marginBottom: 10 }}>
        Pluto's Terminal <strong>{latest.tag}</strong> is out (you're on <code style={{ fontSize: 10 }}>v{currentVersion}</code>).
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => openExternal(latest.url)}
          style={{
            background: ACCENT_BLUE,
            color: "#fff",
            padding: "5px 12px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 10,
            fontWeight: 600,
            textDecoration: "none",
            cursor: "pointer",
            border: "none",
          }}
        >
          Download
        </button>
        <button
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "1px solid #2B2B2B",
            color: "#9D9D9D",
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
