// Pack URL loader — paste a URL to a .deck.json (raw GitHub, gist, or
// arbitrary host that allows CORS) and load it directly. Closes the share
// loop: pack export downloads a .deck.json → upload to gist → paste URL
// in any other instance → instant load.
//
// CORS-restricted hosts will fail to fetch from the webview; toast surfaces
// the error and suggests using `📁 from file` after manual download.

import { useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;

const URL_EXAMPLES = [
  "https://raw.githubusercontent.com/<user>/<repo>/main/my-pack.deck.json",
  "https://gist.githubusercontent.com/<user>/<gist-id>/raw/my-pack.deck.json",
];

export default function PackUrlModal({ open, onClose, onLoadPack }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const handleLoad = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("Enter a URL first.");
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      toast.error("URL must start with http:// or https://");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(trimmed, { headers: { Accept: "application/json,text/plain,*/*" } });
      if (!res.ok) {
        toast.error(`Fetch failed: HTTP ${res.status} ${res.statusText}`);
        return;
      }
      const text = await res.text();
      let pack;
      try {
        pack = JSON.parse(text);
      } catch (parseErr) {
        toast.error(`Pack isn't valid JSON: ${parseErr.message}`);
        return;
      }
      if (!pack || !Array.isArray(pack.panels) || pack.panels.length === 0) {
        toast.error("Pack is missing or has empty panels[] array.");
        return;
      }
      onLoadPack(pack);
      toast.success(`Pack "${pack.name || "(unnamed)"}" loaded from URL.`);
      setUrl("");
      onClose();
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/cors|cross-origin|networkerror|failed to fetch/i.test(msg)) {
        toast.error("Couldn't fetch (CORS or network blocked). Download the file manually and use 📁 from file instead.");
      } else {
        toast.error(`Fetch failed: ${msg.slice(0, 200)}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} title="Load pack from URL" onClose={onClose} width={560}>
      <p style={{ color: FG, fontSize: 12, lineHeight: 1.7, marginBottom: 16 }}>
        Paste a URL to a <code style={codeStyle}>.deck.json</code> file. Works with raw GitHub, gist raw URLs, or any HTTPS host that allows CORS.
      </p>

      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !loading) handleLoad(); }}
        placeholder="https://raw.githubusercontent.com/.../my-pack.deck.json"
        autoFocus
        style={{
          width: "100%",
          background: "#0a0a0a",
          border: `1px solid ${BORDER}`,
          color: FG_ACTIVE,
          padding: "10px 12px",
          borderRadius: 4,
          fontFamily: M,
          fontSize: 11,
          outline: "none",
          boxSizing: "border-box",
          marginBottom: 12,
        }}
      />

      <div style={{ color: FG_DIM, fontSize: 10, lineHeight: 1.6, marginBottom: 18 }}>
        Examples:
        {URL_EXAMPLES.map((ex, i) => (
          <div key={i} style={{ marginTop: 4 }}>
            <code style={{ ...codeStyle, fontSize: 9 }}>{ex}</code>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onClose} disabled={loading} style={chipBtnStyle}>cancel</button>
        <button
          onClick={handleLoad}
          disabled={loading || !url.trim()}
          style={{
            ...primaryBtnStyle,
            opacity: (loading || !url.trim()) ? 0.5 : 1,
            cursor: (loading || !url.trim()) ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "fetching…" : "load"}
        </button>
      </div>
    </Modal>
  );
}

const codeStyle = {
  background: "#0a0a0a",
  padding: "1px 4px",
  borderRadius: 2,
  fontSize: 10,
};

const chipBtnStyle = {
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: FG,
  padding: "6px 16px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  cursor: "pointer",
};

const primaryBtnStyle = {
  background: ACCENT,
  border: `1px solid ${ACCENT}`,
  color: "#001",
  padding: "6px 16px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
