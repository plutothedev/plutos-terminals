import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const BG = "#181818";
const PAGE = "#0a0a0a";
const FG = "#CCCCCC";
const FG_DIM = "#9D9D9D";
const BORDER = "#2B2B2B";
const ACCENT = "#4DAAFC";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

// Pulls the basename out of a Windows or POSIX path.
function basename(p) {
  if (!p) return "";
  const stripped = p.replace(/[\/\\]+$/, "");
  const m = stripped.match(/[^\/\\]+$/);
  return m ? m[0] : stripped;
}

export default function ProjectDialog({ open, initial, onSave, onClose }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [startCommandsText, setStartCommandsText] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [picking, setPicking] = useState(false);
  // Tracks whether the user has typed a custom name; if not, name auto-syncs
  // from the basename of the path field.
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(initial?.path || "");
    setName(initial?.name || "");
    setStartCommandsText((initial?.startCommands || []).join("\n"));
    setAutoApprove(!!initial?.autoApprove);
    setNameTouched(!!initial?.name);
  }, [open, initial]);

  if (!open) return null;

  const browse = async () => {
    setPicking(true);
    try {
      const picked = await invoke("pick_directory");
      if (picked) {
        setPath(picked);
        if (!nameTouched) setName(basename(picked));
      }
    } catch (e) {
      console.error("pick_directory failed:", e);
    } finally {
      setPicking(false);
    }
  };

  const handlePathChange = (v) => {
    setPath(v);
    if (!nameTouched) setName(basename(v));
  };

  const canSave = path.trim().length > 0 && name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const startCommands = startCommandsText
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    onSave({
      path: path.trim(),
      name: name.trim(),
      startCommands,
      autoApprove,
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9990,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 6,
          width: 460,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          boxSizing: "border-box",
          fontFamily: M,
          color: FG,
          fontSize: 12,
          padding: 16,
        }}
      >
        <div style={{ fontSize: 13, color: "#E6E6E6", marginBottom: 14, letterSpacing: 0.5 }}>
          {initial ? "EDIT PROJECT" : "ADD PROJECT"}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", color: FG_DIM, fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>Path</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={path}
              onChange={(e) => handlePathChange(e.target.value)}
              placeholder="C:\path\to\project"
              spellCheck={false}
              style={{
                flex: 1,
                background: PAGE,
                border: `1px solid ${BORDER}`,
                color: FG,
                padding: "6px 8px",
                borderRadius: 3,
                fontFamily: M,
                fontSize: 12,
                outline: "none",
                minWidth: 0,
              }}
            />
            <button
              onClick={browse}
              disabled={picking}
              style={{
                background: "transparent",
                border: `1px solid ${BORDER}`,
                color: ACCENT,
                padding: "6px 12px",
                borderRadius: 3,
                fontFamily: M,
                fontSize: 11,
                cursor: picking ? "wait" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {picking ? "..." : "Browse"}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", color: FG_DIM, fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>Name</label>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
            placeholder="my-project"
            spellCheck={false}
            style={{
              width: "100%",
              background: PAGE,
              border: `1px solid ${BORDER}`,
              color: FG,
              padding: "6px 8px",
              borderRadius: 3,
              fontFamily: M,
              fontSize: 12,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", color: FG_DIM, fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Start commands (optional, one per line)
          </label>
          <textarea
            value={startCommandsText}
            onChange={(e) => setStartCommandsText(e.target.value)}
            placeholder={"claude\n# or\ncodex\n# or any shell command"}
            spellCheck={false}
            rows={4}
            style={{
              width: "100%",
              background: PAGE,
              border: `1px solid ${BORDER}`,
              color: FG,
              padding: "6px 8px",
              borderRadius: 3,
              fontFamily: M,
              fontSize: 12,
              outline: "none",
              resize: "vertical",
              boxSizing: "border-box",
              minHeight: 80,
            }}
          />
          <div style={{ color: FG_DIM, fontSize: 10, marginTop: 4 }}>
            These run automatically each time you open this project in a panel.
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", padding: "8px 10px", background: PAGE, border: `1px solid ${BORDER}`, borderRadius: 3 }}>
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              style={{ marginTop: 2, accentColor: ACCENT }}
            />
            <span style={{ flex: 1 }}>
              <div style={{ color: FG, fontSize: 12, marginBottom: 2 }}>Auto-approve permission prompts</div>
              <div style={{ color: FG_DIM, fontSize: 10, lineHeight: 1.4 }}>
                When this project's tab is in the background and Claude pauses for a tool-use confirmation, Pluto's Terminals sends &quot;1&quot; (Yes) automatically.
                Throttled to once every 3s. Disable if you want to review every action.
              </div>
            </span>
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: FG_DIM,
              padding: "6px 14px",
              borderRadius: 3,
              fontFamily: M,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            style={{
              background: canSave ? ACCENT : "transparent",
              border: `1px solid ${canSave ? ACCENT : BORDER}`,
              color: canSave ? "#001" : "#444",
              padding: "6px 14px",
              borderRadius: 3,
              fontFamily: M,
              fontSize: 11,
              fontWeight: 600,
              cursor: canSave ? "pointer" : "not-allowed",
            }}
          >
            {initial ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
