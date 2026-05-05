// Curated MCP servers — name, description, install command for Claude Code,
// copy button. Real one-click install logic is multi-day per-MCP work; v0.1.0
// ships with copy-paste UX so users get a curated discovery surface without
// having to google "how to install MCP filesystem server claude code."

import { useState } from "react";
import Modal, { MODAL_COLORS } from "./Modal.jsx";

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

  const onCopy = (mcp) => {
    navigator.clipboard.writeText(mcp.command).then(() => {
      setCopiedId(mcp.id);
      setTimeout(() => setCopiedId((c) => (c === mcp.id ? null : c)), 1500);
    }).catch(() => {
      window.alert("Copy failed — select the command text manually and Ctrl+C.");
    });
  };

  return (
    <Modal open={open} title="MCP Servers — Install Commands" onClose={onClose} width={680}>
      <p style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.7, marginBottom: 18 }}>
        Curated list of popular MCP (Model Context Protocol) servers that extend Claude Code. Click <strong style={{ color: ACCENT }}>copy command</strong>,
        paste into any terminal pane, run. Auto-installer (one-click) is on the roadmap but the install commands themselves are stable and copy-paste-able today.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {MCPS.map((mcp) => (
          <div
            key={mcp.id}
            style={{
              background: "#0a0a0a",
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
                background: "#181818",
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
              <button
                onClick={() => onCopy(mcp)}
                style={{
                  background: copiedId === mcp.id ? "#34D399" : "transparent",
                  border: `1px solid ${copiedId === mcp.id ? "#34D399" : ACCENT}`,
                  color: copiedId === mcp.id ? "#001" : ACCENT,
                  padding: "5px 12px",
                  borderRadius: 3,
                  fontFamily: M,
                  fontSize: 10,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {copiedId === mcp.id ? "✓ copied" : "copy command"}
              </button>
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
        <code style={{ background: "#181818", padding: "1px 4px", borderRadius: 2 }}>claude mcp add &lt;name&gt; -- npx -y &lt;package&gt;</code>.
      </div>
    </Modal>
  );
}
