import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const BG = "var(--phn-surface-bg, #181818)";
const PAGE = "var(--phn-page-bg, #0a0a0a)";
const FG = "var(--phn-text-fg, #CCCCCC)";
const FG_DIM = "var(--phn-text-dim, #9D9D9D)";
const BORDER = "var(--phn-surface-border, #2B2B2B)";
const ACCENT = "var(--phn-link, #4DAAFC)";
const M = "'JetBrains Mono', Menlo, Monaco, monospace";

const inputStyle = {
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
  minWidth: 0,
};

const labelStyle = {
  display: "block",
  color: FG_DIM,
  fontSize: 10,
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

// Pulls the basename out of a Windows or POSIX path.
function basename(p) {
  if (!p) return "";
  const stripped = p.replace(/[\/\\]+$/, "");
  const m = stripped.match(/[^\/\\]+$/);
  return m ? m[0] : stripped;
}

// Session type for an existing record. SSH sessions carry a `connection`; older
// records (created before the type field existed) are local by default.
function sessionType(initial) {
  if (!initial) return "local";
  if (initial.type) return initial.type;
  return initial.connection ? "ssh" : "local";
}

// One session = a saved connection. Local sessions spawn a shell at `path`;
// SSH sessions (preview — backend lands in a later phase) connect to a host.
export default function ProjectDialog({ open, initial, onSave, onClose }) {
  const [type, setType] = useState("local");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [startCommandsText, setStartCommandsText] = useState("");

  // Local
  const [path, setPath] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [picking, setPicking] = useState(false);

  // SSH
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authMethod, setAuthMethod] = useState("password");
  const [keyPath, setKeyPath] = useState("");

  useEffect(() => {
    if (!open) return;
    const t = sessionType(initial);
    setType(t);
    setName(initial?.name || "");
    setNameTouched(!!initial?.name);
    setStartCommandsText((initial?.startCommands || []).join("\n"));

    setPath(initial?.path || "");
    setAutoApprove(!!initial?.autoApprove);
    setPicking(false);

    const c = initial?.connection || {};
    setHost(c.host || "");
    setPort(c.port != null ? String(c.port) : "22");
    setUser(c.user || "");
    setAuthMethod(c.auth?.method || "password");
    setKeyPath(c.auth?.keyPath || "");
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

  const handleHostChange = (v) => {
    setHost(v);
    if (!nameTouched) setName(user ? `${user}@${v}` : v);
  };
  const handleUserChange = (v) => {
    setUser(v);
    if (!nameTouched && host) setName(`${v}@${host}`);
  };

  const startCommands = () =>
    startCommandsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

  const canSave =
    name.trim().length > 0 &&
    (type === "local"
      ? path.trim().length > 0
      : host.trim().length > 0 && user.trim().length > 0);

  const save = () => {
    if (!canSave) return;
    if (type === "local") {
      onSave({
        type: "local",
        name: name.trim(),
        path: path.trim(),
        startCommands: startCommands(),
        autoApprove,
      });
    } else {
      const portNum = parseInt(port, 10);
      onSave({
        type: "ssh",
        name: name.trim(),
        startCommands: startCommands(),
        connection: {
          host: host.trim(),
          port: Number.isFinite(portNum) && portNum > 0 ? portNum : 22,
          user: user.trim(),
          auth: { method: authMethod, keyPath: keyPath.trim() || null },
        },
      });
    }
  };

  const typeTab = (value, label) => (
    <button
      onClick={() => setType(value)}
      style={{
        flex: 1,
        background: type === value ? PAGE : "transparent",
        border: `1px solid ${type === value ? ACCENT : BORDER}`,
        color: type === value ? ACCENT : FG_DIM,
        padding: "7px 10px",
        borderRadius: 3,
        fontFamily: M,
        fontSize: 11,
        letterSpacing: 0.4,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

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
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
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
          {initial ? "EDIT SESSION" : "ADD SESSION"}
        </div>

        {/* Type selector */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {typeTab("local", "🖥  Local shell")}
          {typeTab("ssh", "🌐  SSH")}
        </div>

        {type === "ssh" && (
          <div
            style={{
              marginBottom: 14,
              padding: "7px 10px",
              borderRadius: 3,
              border: `1px solid ${BORDER}`,
              background: PAGE,
              color: FG_DIM,
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            ⓘ Connects over SSH (libssh2). The host key is verified against your
            <code> ~/.ssh/known_hosts</code>; password auth prompts at connect time and
            is never saved to disk.
          </div>
        )}

        {type === "local" ? (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Path</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={path}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder="C:\path\to\project"
                spellCheck={false}
                style={{ ...inputStyle, flex: 1 }}
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
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 2, minWidth: 0 }}>
                <label style={labelStyle}>Host</label>
                <input
                  value={host}
                  onChange={(e) => handleHostChange(e.target.value)}
                  placeholder="example.com or 10.0.0.4"
                  spellCheck={false}
                  style={inputStyle}
                />
              </div>
              <div style={{ width: 80, flexShrink: 0 }}>
                <label style={labelStyle}>Port</label>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="22"
                  spellCheck={false}
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Username</label>
              <input
                value={user}
                onChange={(e) => handleUserChange(e.target.value)}
                placeholder="root"
                spellCheck={false}
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Authentication</label>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  ["password", "Password"],
                  ["key", "Private key"],
                  ["agent", "SSH agent"],
                ].map(([val, lbl]) => (
                  <button
                    key={val}
                    onClick={() => setAuthMethod(val)}
                    style={{
                      flex: 1,
                      background: authMethod === val ? PAGE : "transparent",
                      border: `1px solid ${authMethod === val ? ACCENT : BORDER}`,
                      color: authMethod === val ? ACCENT : FG_DIM,
                      padding: "6px 4px",
                      borderRadius: 3,
                      fontFamily: M,
                      fontSize: 10,
                      cursor: "pointer",
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            {authMethod === "key" && (
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Private key path</label>
                <input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                  style={inputStyle}
                />
              </div>
            )}
          </>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Name</label>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder={type === "ssh" ? "user@host" : "my-project"}
            spellCheck={false}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>
            {type === "ssh"
              ? "Commands to run after connect (optional, one per line)"
              : "Start commands (optional, one per line)"}
          </label>
          <textarea
            value={startCommandsText}
            onChange={(e) => setStartCommandsText(e.target.value)}
            placeholder={"claude\n# or\ncodex\n# or any shell command"}
            spellCheck={false}
            rows={4}
            style={{ ...inputStyle, resize: "vertical", minHeight: 80 }}
          />
          <div style={{ color: FG_DIM, fontSize: 10, marginTop: 4 }}>
            These run automatically each time you open this session in a panel.
          </div>
        </div>

        {type === "local" && (
          <div style={{ marginBottom: 16 }}>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                cursor: "pointer",
                padding: "8px 10px",
                background: PAGE,
                border: `1px solid ${BORDER}`,
                borderRadius: 3,
              }}
            >
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                style={{ marginTop: 2, accentColor: ACCENT }}
              />
              <span style={{ flex: 1 }}>
                <div style={{ color: FG, fontSize: 12, marginBottom: 2 }}>Auto-approve permission prompts</div>
                <div style={{ color: FG_DIM, fontSize: 10, lineHeight: 1.4 }}>
                  When this session's tab is in the background and Claude pauses for a tool-use confirmation, Pluto's Terminals sends &quot;1&quot; (Yes) automatically.
                  Throttled to once every 3s. Disable if you want to review every action.
                </div>
              </span>
            </label>
          </div>
        )}

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
