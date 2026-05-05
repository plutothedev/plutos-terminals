// Auto-update check. On app start, hit the GitHub Releases API for the latest
// release tag, compare to the current bundled version. If a newer version is
// available, show a dismissible banner with a link to the release page.
//
// Failure modes (network down, rate limit, repo deleted, etc.) all silently
// no-op — the banner just doesn't appear.

import { useEffect, useState } from "react";

const REPO_OWNER = "plutothedev";
const REPO_NAME = "plutos-terminals";
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

const PLUTO_MAGENTA = "#FF0080";
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
    fetch(GITHUB_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
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
        background: "#181818",
        border: `1px solid ${PLUTO_MAGENTA}`,
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
      <div style={{ color: PLUTO_MAGENTA, fontSize: 10, letterSpacing: 0.5, marginBottom: 6 }}>
        UPDATE AVAILABLE
      </div>
      <div style={{ marginBottom: 10 }}>
        Pluto's Terminals <strong>{latest.tag}</strong> is out (you're on <code style={{ fontSize: 10 }}>v{currentVersion}</code>).
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <a
          href={latest.url}
          target="_blank"
          rel="noreferrer"
          style={{
            background: PLUTO_MAGENTA,
            color: "#fff",
            padding: "5px 12px",
            borderRadius: 3,
            fontFamily: M,
            fontSize: 10,
            fontWeight: 600,
            textDecoration: "none",
            cursor: "pointer",
          }}
        >
          download
        </a>
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
          later
        </button>
      </div>
    </div>
  );
}
