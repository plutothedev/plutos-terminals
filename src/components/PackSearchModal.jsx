// Pack search modal — searchable list of recent + bundled packs.
// Esc / click-backdrop closes. Arrow keys navigate; Enter loads. v0.1.15.

import { useEffect, useMemo, useRef, useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;

export default function PackSearchModal({ open, recentPacks, bundledPacks, onLoad, onClose }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);

  const items = useMemo(() => {
    const recents = (recentPacks || []).map((r, i) => ({
      kind: "recent",
      idx: i,
      key: `recent-${i}`,
      name: r.name || "(unnamed)",
      description: r.data?.description || "",
      source: r.source,
      pack: r.data,
    }));
    const bundled = (bundledPacks || []).map((p, i) => ({
      kind: "bundled",
      idx: i,
      key: `bundled-${p.filename}`,
      name: p.data?.name || p.filename,
      description: p.data?.description || "",
      source: "bundled",
      pack: p.data,
    }));
    return [...recents, ...bundled];
  }, [recentPacks, bundledPacks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[highlight];
      if (it && it.pack) {
        onLoad(it.pack, it.source);
        onClose();
      }
    }
  };

  return (
    <Modal open={open} title="Find a Pack" onClose={onClose} width={560}>
      <input
        ref={inputRef}
        type="text"
        placeholder="search by name or description… (↑↓ to navigate, Enter to load)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        style={inputStyle}
      />
      <div style={{ marginTop: 14, maxHeight: 360, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div style={{ color: FG_DIM, fontSize: 11, padding: "20px 0", textAlign: "center" }}>
            No matches for "{query}"
          </div>
        ) : (
          filtered.map((it, i) => (
            <div
              key={it.key}
              onClick={() => { onLoad(it.pack, it.source); onClose(); }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: "10px 12px",
                borderRadius: 4,
                cursor: "pointer",
                background: i === highlight ? "rgba(77,170,252,0.12)" : "transparent",
                border: `1px solid ${i === highlight ? ACCENT : "transparent"}`,
                marginBottom: 4,
                transition: "background 80ms ease, border-color 80ms ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: FG_ACTIVE, fontSize: 12, fontWeight: 600 }}>
                  {it.kind === "recent" ? "🕐 " : "📦 "}{it.name}
                </span>
                <span style={{ color: FG_DIM, fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase" }}>
                  {it.source}
                </span>
              </div>
              <div style={{ color: FG, fontSize: 10, lineHeight: 1.5 }}>
                {it.description.length > 180 ? it.description.slice(0, 180) + "…" : it.description}
              </div>
            </div>
          ))
        )}
      </div>
      <div style={{ marginTop: 14, color: FG_DIM, fontSize: 10, textAlign: "right" }}>
        {filtered.length} {filtered.length === 1 ? "result" : "results"} · Esc to close
      </div>
    </Modal>
  );
}

const inputStyle = {
  width: "100%",
  background: "var(--phn-page-bg, #0a0a0a)",
  border: `1px solid ${BORDER}`,
  color: FG_ACTIVE,
  padding: "10px 12px",
  borderRadius: 4,
  fontFamily: M,
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};
