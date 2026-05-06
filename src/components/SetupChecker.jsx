// First-run / on-demand prereq checker. Walks the user through Node.js +
// Claude Code CLI + Anthropic API key + a live API test in one modal, so a
// fresh download of the app can verify their setup before typing `claude`
// and hitting "command not recognized."
//
// Uses the check_command_version Tauri command for the binary detection
// (resolves the binary on the parent process's PATH at the time the app
// launched — not the ephemeral PATH inside spawned shells).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#FF0080";
const GREEN = "#34D399";
const YELLOW = "#FBBF24";

const CLAUDE_INSTALL_CMD = "npm install -g @anthropic-ai/claude-code";

export default function SetupChecker({ open, st, userSt = {}, onClose, onOpenSettings }) {
  const toast = useToast();
  // Each check: pending | found | missing
  const [nodeStatus, setNodeStatus] = useState({ state: "pending", value: null });
  const [npmStatus, setNpmStatus] = useState({ state: "pending", value: null });
  const [claudeStatus, setClaudeStatus] = useState({ state: "pending", value: null });
  const [keyStatus, setKeyStatus] = useState({ state: "pending", value: null });
  const [apiTest, setApiTest] = useState({ state: "idle", message: "" });
  const [copied, setCopied] = useState(false);

  // v0.1.21: anthropicKey moved from per-window st to shared userSt.
  // Fall back to st.anthropicKey for users still on legacy state.
  const apiKey = (userSt && typeof userSt.anthropicKey === "string" && userSt.anthropicKey.length > 0)
    ? userSt.anthropicKey
    : ((st && typeof st.anthropicKey === "string") ? st.anthropicKey : "");
  const hasKey = apiKey.length > 0;

  const runChecks = useCallback(async () => {
    setNodeStatus({ state: "pending", value: null });
    setNpmStatus({ state: "pending", value: null });
    setClaudeStatus({ state: "pending", value: null });
    setKeyStatus({ state: hasKey ? "found" : "missing", value: hasKey ? "saved in app" : null });

    const checks = [
      ["node", setNodeStatus],
      ["npm", setNpmStatus],
      ["claude", setClaudeStatus],
    ];
    for (const [bin, setter] of checks) {
      try {
        const v = await invoke("check_command_version", { name: bin });
        if (v && typeof v === "string" && v.length > 0) {
          setter({ state: "found", value: v });
        } else {
          setter({ state: "missing", value: null });
        }
      } catch (e) {
        setter({ state: "missing", value: null });
      }
    }
  }, [hasKey]);

  useEffect(() => {
    if (open) runChecks();
  }, [open, runChecks]);

  const onCopyClaudeInstall = () => {
    navigator.clipboard.writeText(CLAUDE_INSTALL_CMD).then(() => {
      setCopied(true);
      toast.success("Install command copied.");
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      toast.error("Copy failed — select the command text manually and Ctrl+C.");
    });
  };

  const onTestApi = async () => {
    if (!hasKey) {
      setApiTest({ state: "fail", message: "No API key saved — click 'open settings' below to add one." });
      return;
    }
    setApiTest({ state: "pending", message: "Calling Anthropic API…" });
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.ok) {
        setApiTest({ state: "ok", message: "Live API call succeeded — your key works." });
        return;
      }
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error && data.error.message) detail = data.error.message;
      } catch (_) { /* ignore */ }
      setApiTest({ state: "fail", message: detail });
    } catch (e) {
      setApiTest({ state: "fail", message: String((e && e.message) || e) });
    }
  };

  const allGood = nodeStatus.state === "found"
    && npmStatus.state === "found"
    && claudeStatus.state === "found"
    && hasKey;

  return (
    <Modal open={open} title="Setup Check" onClose={onClose} width={620}>
      <p style={{ color: FG, fontSize: 12, lineHeight: 1.7, marginBottom: 18 }}>
        Pluto's Terminals is a terminal app — it expects a few things on your machine.
        Run through this once and you're set. Re-open anytime via the <strong style={{ color: ACCENT }}>🚀 setup</strong> button in the header.
      </p>

      <Check
        label="Node.js"
        status={nodeStatus}
        installHint={(
          <>
            Not found. Install from <Link href="https://nodejs.org/">nodejs.org</Link> (LTS).
            Then close + reopen Pluto's Terminals so the new PATH is picked up, and re-run this check.
          </>
        )}
      />

      <Check
        label="npm (bundled with Node.js)"
        status={npmStatus}
        installHint={(
          <>
            npm should install with Node.js. If it's missing, your Node.js install may be incomplete — reinstall from <Link href="https://nodejs.org/">nodejs.org</Link>.
          </>
        )}
      />

      <Check
        label="Claude Code CLI"
        status={claudeStatus}
        installHint={(
          <>
            <div style={{ marginBottom: 8 }}>
              Not found. With Node.js installed, run this in any terminal pane (or a fresh PowerShell window):
            </div>
            <Code>{CLAUDE_INSTALL_CMD}</Code>
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button onClick={onCopyClaudeInstall} style={chipBtnStyle}>
                {copied ? "✓ copied" : "copy command"}
              </button>
              <Link href="https://docs.anthropic.com/claude/docs/claude-code">install docs ↗</Link>
            </div>
          </>
        )}
      />

      <Check
        label="Anthropic API key (saved in app)"
        status={keyStatus}
        installHint={(
          <>
            <div style={{ marginBottom: 8 }}>
              Not saved. Get a key at <Link href="https://console.anthropic.com/">console.anthropic.com</Link> → "API Keys" → create new.
              Then paste it into Pluto's Terminals via <strong style={{ color: ACCENT }}>⚙️ settings</strong>.
            </div>
            <button onClick={() => { onClose(); if (onOpenSettings) onOpenSettings(); }} style={chipBtnStyle}>
              open settings
            </button>
          </>
        )}
      />

      <div style={{ marginTop: 22, padding: "14px 16px", background: "var(--phn-page-bg, #0a0a0a)", border: `1px solid ${BORDER}`, borderRadius: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ color: FG_ACTIVE, fontSize: 12, fontWeight: 600 }}>Live API test</div>
          <button onClick={onTestApi} style={primaryBtnStyle} disabled={apiTest.state === "pending"}>
            {apiTest.state === "pending" ? "testing…" : "test connection"}
          </button>
        </div>
        <div style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.6 }}>
          Calls the Anthropic Messages API with your saved key + a 1-token throwaway request to verify the key works.
          Doesn't need Node.js or Claude CLI — direct browser-to-API.
        </div>
        {apiTest.state !== "idle" && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 12px",
              borderRadius: 4,
              fontSize: 11,
              background:
                apiTest.state === "ok" ? "rgba(52, 211, 153, 0.12)"
                : apiTest.state === "fail" ? "rgba(255, 0, 128, 0.12)"
                : "rgba(251, 191, 36, 0.12)",
              color:
                apiTest.state === "ok" ? GREEN
                : apiTest.state === "fail" ? PLUTO_MAGENTA
                : YELLOW,
              border: `1px solid ${
                apiTest.state === "ok" ? GREEN
                : apiTest.state === "fail" ? PLUTO_MAGENTA
                : YELLOW
              }`,
            }}
          >
            {apiTest.state === "pending" ? "⏳" : apiTest.state === "ok" ? "✓" : "✗"} {apiTest.message}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22 }}>
        <button onClick={runChecks} style={chipBtnStyle}>re-run checks</button>
        <div style={{ color: allGood ? GREEN : FG_DIM, fontSize: 11, fontWeight: allGood ? 600 : 400 }}>
          {allGood ? "✓ all set — type `claude` in any tab" : "complete the items above to be ready"}
        </div>
        <button onClick={onClose} style={primaryBtnStyle}>done</button>
      </div>
    </Modal>
  );
}

function Check({ label, status, installHint }) {
  const icon =
    status.state === "found" ? "✓"
    : status.state === "pending" ? "⋯"
    : "✗";
  const color =
    status.state === "found" ? GREEN
    : status.state === "pending" ? FG_DIM
    : PLUTO_MAGENTA;
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "12px 14px",
        background: "var(--phn-page-bg, #0a0a0a)",
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: status.state === "missing" ? 10 : 0 }}>
        <span style={{ color, fontSize: 14, fontWeight: 700, fontFamily: M, minWidth: 18 }}>{icon}</span>
        <span style={{ color: FG_ACTIVE, fontSize: 12, flex: 1 }}>{label}</span>
        <span style={{ color: FG_DIM, fontSize: 10, fontFamily: M }}>
          {status.state === "found" ? status.value : status.state === "pending" ? "checking…" : "not found"}
        </span>
      </div>
      {status.state === "missing" && (
        <div style={{ color: FG, fontSize: 11, lineHeight: 1.6, paddingLeft: 28 }}>
          {installHint}
        </div>
      )}
    </div>
  );
}

function Link({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: ACCENT, textDecoration: "none" }}>
      {children}
    </a>
  );
}

function Code({ children }) {
  return (
    <div
      style={{
        background: "var(--phn-surface-bg, #181818)",
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        padding: "8px 10px",
        fontSize: 11,
        color: FG_ACTIVE,
        fontFamily: M,
        userSelect: "all",
        wordBreak: "break-all",
      }}
    >
      {children}
    </div>
  );
}

const chipBtnStyle = {
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: FG,
  padding: "6px 12px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryBtnStyle = {
  background: ACCENT,
  border: `1px solid ${ACCENT}`,
  color: "#001",
  padding: "6px 18px",
  borderRadius: 3,
  fontFamily: M,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
