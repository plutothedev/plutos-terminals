// Curated MCP servers — name, description, install command for Claude Code,
// copy button. Real one-click install logic is multi-day per-MCP work; v0.1.0
// ships with copy-paste UX so users get a curated discovery surface without
// having to google "how to install MCP filesystem server claude code."

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;

const MCPS = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read + write files in a specific root directory. Lets Claude inspect / edit project files directly.",
    command: 'claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ${PWD}',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    notes: "Replace ${PWD} with the absolute path of the directory you want to expose. Restrict scope — Claude inherits whatever access this directory has.",
  },
  {
    id: "github",
    name: "GitHub",
    description: "List repos, read issues + PRs, create issues. Useful for repo navigation + PR review without leaving the terminal.",
    command: 'claude mcp add github -- npx -y @modelcontextprotocol/server-github',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    notes: "Requires GITHUB_PERSONAL_ACCESS_TOKEN env var. Generate at github.com/settings/tokens with repo scope.",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Headless browser automation. Lets Claude navigate web pages, click links, fill forms, take screenshots.",
    command: 'claude mcp add puppeteer -- npx -y @modelcontextprotocol/server-puppeteer',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    notes: "Spawns a Chromium instance. Heavier than filesystem; only enable when needed.",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via Brave Search API. Lets Claude grab fresh search results without going through a separate tool.",
    command: 'claude mcp add brave-search -- npx -y @modelcontextprotocol/server-brave-search',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    notes: "Requires BRAVE_API_KEY env var. Free tier at brave.com/search/api.",
  },
  {
    id: "fetch",
    name: "Fetch (HTTP)",
    description: "Generic HTTP fetch — Claude can pull URLs and extract content. Lighter than puppeteer for plain HTML/JSON.",
    command: 'claude mcp add fetch -- npx -y @modelcontextprotocol/server-fetch',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    notes: "No auth or external dependencies. Default starting point if you just need 'read URL X'.",
  },
  {
    id: "memory",
    name: "Memory (Knowledge Graph)",
    description: "Persistent knowledge graph Claude can read + write across sessions. Useful for long-running projects.",
    command: 'claude mcp add memory -- npx -y @modelcontextprotocol/server-memory',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    notes: "Stores graph in a local file. Each new project = fresh graph unless you explicitly share state dir.",
  },
];

export default function McpInstaller({ open, onClose }) {
  const [copiedId, setCopiedId] = useState(null);
  // installState[id] = "idle" | "installing" | "ok" | "error"
  const [installState, setInstallState] = useState({});
  const toast = useToast();

  const onCopy = (mcp) => {
    navigator.clipboard.writeText(mcp.command).then(() => {
      setCopiedId(mcp.id);
      toast.success(`${mcp.name} install command copied — paste in any pane.`);
      setTimeout(() => setCopiedId((c) => (c === mcp.id ? null : c)), 1500);
    }).catch(() => {
      toast.error("Copy failed — select the command text manually and Ctrl+C.");
    });
  };

  const onInstall = async (mcp) => {
    // Filesystem MCP needs a path argument — default to user home via the
    // Windows env var expansion that cmd.exe handles natively.
    let cmd = mcp.command.replace(/\$\{PWD\}/g, "%USERPROFILE%");
    setInstallState((s) => ({ ...s, [mcp.id]: "installing" }));
    try {
      const result = await invoke("mcp_install", { command: cmd });
      if (result && result.ok) {
        setInstallState((s) => ({ ...s, [mcp.id]: "ok" }));
        toast.success(`${mcp.name} installed. Restart any open Claude sessions to pick it up.`);
      } else {
        setInstallState((s) => ({ ...s, [mcp.id]: "error" }));
        const detail = (result && (result.stderr || result.stdout)) || "Unknown error";
        toast.error(`${mcp.name} install failed: ${String(detail).slice(0, 200)}`);
      }
    } catch (err) {
      setInstallState((s) => ({ ...s, [mcp.id]: "error" }));
      toast.error(`${mcp.name} install failed: ${String(err).slice(0, 200)}`);
    }
  };

  return (
    <Modal open={open} title="MCP Servers — Install Commands" onClose={onClose} width={680}>
      <p style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.7, marginBottom: 18 }}>
        Curated list of popular MCP (Model Context Protocol) servers that extend Claude Code. Click <strong style={{ color: ACCENT }}>install</strong> and the app runs <code style={{ background: "var(--phn-page-bg, #0a0a0a)", padding: "1px 4px", borderRadius: 2 }}>claude mcp add ...</code> for you. Or click <strong>copy</strong> to paste the command into a pane manually. <strong>Restart any open Claude sessions</strong> after install for them to pick up the new MCP.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {MCPS.map((mcp) => (
          <div
            key={mcp.id}
            style={{
              background: "var(--phn-page-bg, #0a0a0a)",
              border: `1px solid ${BORDER}`,
              borderRadius: 6,
              padding: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ color: FG_ACTIVE, fontSize: 13, fontWeight: 600 }}>{mcp.name}</div>
              <a
                href={mcp.docs}
                target="_blank"
                rel="noreferrer"
                style={{ color: FG_DIM, fontSize: 10, textDecoration: "none" }}
              >
                docs ↗
              </a>
            </div>
            <div style={{ color: FG, fontSize: 11, lineHeight: 1.6, marginBottom: 10 }}>
              {mcp.description}
            </div>
            <div
              style={{
                background: "var(--phn-surface-bg, #181818)",
                border: `1px solid ${BORDER}`,
                borderRadius: 4,
                padding: "8px 10px",
                fontSize: 10,
                color: FG_ACTIVE,
                fontFamily: M,
                userSelect: "all",
                marginBottom: 8,
                wordBreak: "break-all",
              }}
            >
              {mcp.command}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ color: FG_DIM, fontSize: 10, lineHeight: 1.5, flex: 1 }}>
                {mcp.notes}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  onClick={() => onCopy(mcp)}
                  style={{
                    background: copiedId === mcp.id ? "#34D399" : "transparent",
                    border: `1px solid ${copiedId === mcp.id ? "#34D399" : BORDER}`,
                    color: copiedId === mcp.id ? "#001" : FG,
                    padding: "5px 10px",
                    borderRadius: 3,
                    fontFamily: M,
                    fontSize: 10,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                  title="Copy the install command to clipboard"
                >
                  {copiedId === mcp.id ? "✓ copied" : "copy"}
                </button>
                <button
                  onClick={() => onInstall(mcp)}
                  disabled={installState[mcp.id] === "installing"}
                  style={{
                    background:
                      installState[mcp.id] === "ok" ? "#34D399"
                      : installState[mcp.id] === "error" ? "#FF0080"
                      : ACCENT,
                    border: `1px solid ${
                      installState[mcp.id] === "ok" ? "#34D399"
                      : installState[mcp.id] === "error" ? "#FF0080"
                      : ACCENT
                    }`,
                    color:
                      installState[mcp.id] === "error" ? "#fff" : "#001",
                    padding: "5px 12px",
                    borderRadius: 3,
                    fontFamily: M,
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: installState[mcp.id] === "installing" ? "wait" : "pointer",
                    whiteSpace: "nowrap",
                    opacity: installState[mcp.id] === "installing" ? 0.7 : 1,
                  }}
                  title={
                    installState[mcp.id] === "ok" ? "Already installed in this session"
                    : installState[mcp.id] === "error" ? "Last install failed — check toast for details"
                    : `Run "${mcp.command}" via your shell`
                  }
                >
                  {installState[mcp.id] === "installing" ? "installing…"
                    : installState[mcp.id] === "ok" ? "✓ installed"
                    : installState[mcp.id] === "error" ? "✗ retry"
                    : "install"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ color: FG_DIM, fontSize: 10, lineHeight: 1.6, marginTop: 18, paddingTop: 14, borderTop: `1px solid ${BORDER}` }}>
        Looking for an MCP not listed? Browse the full registry at{" "}
        <a href="https://github.com/modelcontextprotocol/servers" target="_blank" rel="noreferrer" style={{ color: ACCENT, textDecoration: "none" }}>
          github.com/modelcontextprotocol/servers ↗
        </a>
        . The standard Claude Code install pattern is{" "}
        <code style={{ background: "var(--phn-surface-bg, #181818)", padding: "1px 4px", borderRadius: 2 }}>claude mcp add &lt;name&gt; -- npx -y &lt;package&gt;</code>.
      </div>
    </Modal>
  );
}
