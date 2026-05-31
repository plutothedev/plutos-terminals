// First-run / on-demand prereq checker. Walks the user through Node.js +
// Claude Code CLI + Anthropic API key + a live API test in one modal, so a
// fresh download of the app can verify their setup before typing `claude`
// and hitting "command not recognized."
//
// Uses the check_command_version Tauri command for the binary detection
// (resolves the binary on the parent process's PATH at the time the app
// launched — not the ephemeral PATH inside spawned shells).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@backend";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";
import { openExternal } from "../appMeta.js";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;
const PLUTO_MAGENTA = "#FF0080";
const GREEN = "#34D399";
const YELLOW = "#FBBF24";

const CLAUDE_INSTALL_CMD = "npm install -g @anthropic-ai/claude-code";

export default function SetupChecker({ open, onClose }) {
  const toast = useToast();
  // Each check: pending | found | missing. Keys/models live in the Models
  // section now — this checker only verifies the CLI toolchain is installed.
  const [nodeStatus, setNodeStatus] = useState({ state: "pending", value: null });
  const [npmStatus, setNpmStatus] = useState({ state: "pending", value: null });
  const [claudeStatus, setClaudeStatus] = useState({ state: "pending", value: null });
  const [copied, setCopied] = useState(false);

  const runChecks = useCallback(async () => {
    setNodeStatus({ state: "pending", value: null });
    setNpmStatus({ state: "pending", value: null });
    setClaudeStatus({ state: "pending", value: null });

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
  }, []);

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

  const allGood = nodeStatus.state === "found"
    && npmStatus.state === "found"
    && claudeStatus.state === "found";

  return (
    <Modal open={open} title="Setup Check" onClose={onClose} width={620}>
      <p style={{ color: FG, fontSize: 12, lineHeight: 1.7, marginBottom: 18 }}>
        Pluto's Terminal is a terminal app — it expects a few things on your machine.
        Run through this once and you're set. Re-open anytime via the <strong style={{ color: ACCENT }}>🚀 setup</strong> button in the header.
      </p>

      <Check
        label="Node.js"
        status={nodeStatus}
        installHint={(
          <>
            Not found. Install from <Link href="https://nodejs.org/">nodejs.org</Link> (LTS).
            Then close + reopen Pluto's Terminal so the new PATH is picked up, and re-run this check.
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

      <div style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.6, marginTop: 4, marginBottom: 4 }}>
        API keys & model selection live in the <strong style={{ color: ACCENT }}>Models</strong> section, not here.
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
    <button
      onClick={() => openExternal(href)}
      style={{ color: ACCENT, textDecoration: "none", background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}
    >
      {children}
    </button>
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
