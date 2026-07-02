// Curated MCP servers — name, description, install command for Claude Code,
// copy button. Real one-click install logic is multi-day per-MCP work; v0.1.0
// ships with copy-paste UX so users get a curated discovery surface without
// having to google "how to install MCP filesystem server claude code."

import { useState, useEffect } from "react";
import { invoke } from "@backend";
import Modal, { MODAL_COLORS } from "./Modal.jsx";
import { useToast } from "./Toast.jsx";
import { openExternal } from "../appMeta.js";

const { FG, FG_ACTIVE, FG_DIM, ACCENT, BORDER, M } = MODAL_COLORS;

const MCPS = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read + write files in a specific root directory. Lets Claude inspect / edit project files directly.",
    command: 'claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ${PWD}',
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    notes: "On install you'll be asked to pick the directory to expose. Restrict scope — Claude inherits read+write to whatever directory you choose.",
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

// Tokens needed for specific servers (by id or by keyword in notes).
const NEEDS_TOKEN = {
  github: "GITHUB_PERSONAL_ACCESS_TOKEN",
  "brave-search": "BRAVE_API_KEY",
};

export default function McpInstaller({ open, onClose }) {
  const [copiedId, setCopiedId] = useState(null);
  // installState[id] = "idle" | "installing" | "ok" | "error"
  const [installState, setInstallState] = useState({});
  const [configured, setConfigured] = useState([]);
  const [addingId, setAddingId] = useState(null);
  const toast = useToast();
  // Masked in-app secret prompt (replaces window.prompt for access tokens so a
  // token never renders in cleartext in an OS prompt box). askSecret() shows the
  // sub-modal and resolves with the entered value, or null if the user skips.
  const [secretPrompt, setSecretPrompt] = useState(null); // { label, resolve } | null
  const [secretValue, setSecretValue] = useState("");
  const askSecret = (label) =>
    new Promise((resolve) => { setSecretValue(""); setSecretPrompt({ label, resolve }); });
  const closeSecret = (val) => {
    if (secretPrompt) secretPrompt.resolve(val);
    setSecretPrompt(null);
    setSecretValue("");
  };

  const refreshConfigured = () => {
    invoke("mcp_servers_list").then(setConfigured).catch(() => {});
  };

  useEffect(() => {
    refreshConfigured();
  }, []);

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
    // Pass an explicit argv vector (no shell runs backend-side). The catalog
    // command is a fixed, space-separated template.
    let argv = mcp.command.split(/\s+/).filter(Boolean);
    // A ${PWD} placeholder (the filesystem MCP root) must be an explicit,
    // user-chosen directory — never silently expanded to $HOME, which would grant
    // Claude read+write across the whole home tree (.ssh, .aws, .env, …). Prompt.
    if (argv.includes("${PWD}")) {
      let dir = null;
      try { dir = await invoke("pick_directory"); } catch { dir = null; }
      if (!dir) { toast.info("Install cancelled — pick the directory to expose."); return; }
      argv = argv.map((a) => (a === "${PWD}" ? dir : a));
    }
    setInstallState((s) => ({ ...s, [mcp.id]: "installing" }));
    try {
      const result = await invoke("mcp_install", { argv });
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

  const onAddToAgent = async (mcp) => {
    setAddingId(mcp.id);
    try {
      // Parse argv from the command: split on whitespace, find '--', take everything after.
      const fullArgv = mcp.command.split(/\s+/).filter(Boolean);
      const sepIdx = fullArgv.indexOf("--");
      let realArgv = sepIdx !== -1 ? fullArgv.slice(sepIdx + 1) : fullArgv;

      // Expand directory placeholders via the native folder picker (a real,
      // existing directory — the same picker onInstall uses; avoids window.prompt).
      const needsDir = realArgv.some((a) => /\$\{?PWD\}?|\$HOME|%USERPROFILE%/.test(a));
      if (needsDir) {
        let dir = null;
        try { dir = await invoke("pick_directory"); } catch { dir = null; }
        if (!dir) {
          toast.info("Add to agent cancelled — pick the directory to expose.");
          setAddingId(null);
          return;
        }
        realArgv = realArgv.map((a) =>
          /\$\{?PWD\}?|\$HOME|%USERPROFILE%/.test(a) ? dir : a
        );
      }

      const command = realArgv[0] ?? "npx";
      const args = realArgv.slice(1);

      // Handle token/PAT for servers that need one.
      let secret_keys = [];
      const tokenKey = NEEDS_TOKEN[mcp.id] || (mcp.notes && /token|PAT/i.test(mcp.notes) ? Object.values(NEEDS_TOKEN)[0] : null);
      if (tokenKey || mcp.id === "github") {
        const key = tokenKey || "GITHUB_PERSONAL_ACCESS_TOKEN";
        // Masked in-app modal, not window.prompt: the token must not show in
        // cleartext. It still routes only to secret_set (OS keychain) below.
        const token = await askSecret(`Access token for ${mcp.name} (${key}). Leave blank to skip.`);
        if (token) {
          secret_keys = [key];
          await invoke("secret_set", {
            account: `mcp-secret:${mcp.id}:${key}`,
            secret: token,
          });
        }
      }

      const cfg = {
        id: mcp.id,
        enabled: true,
        transport: "stdio",
        command,
        args,
        env: {},
        url: null,
        secret_keys,
      };

      await invoke("mcp_server_add", { cfg });
      toast.success(`Added ${mcp.name} to the agent`);
      refreshConfigured();
    } catch (err) {
      toast.error(`Failed to add ${mcp.name} to agent: ${String(err).slice(0, 200)}`);
    } finally {
      setAddingId(null);
    }
  };

  const onToggleEnabled = async (srv) => {
    try {
      await invoke("mcp_server_add", { cfg: { ...srv, enabled: !srv.enabled } });
      refreshConfigured();
    } catch (err) {
      toast.error(`Failed to update ${srv.id}: ${String(err).slice(0, 200)}`);
    }
  };

  const onRemoveFromAgent = async (srv) => {
    try {
      await invoke("mcp_server_remove", { id: srv.id });
      refreshConfigured();
    } catch (err) {
      toast.error(`Failed to remove ${srv.id}: ${String(err).slice(0, 200)}`);
    }
  };

  return (
    <Modal open={open} title="MCP Servers — Install Commands" onClose={onClose} width={680}>
      {/* ── Configured-for-agent section ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: FG_DIM, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          Configured for the agent
        </div>
        {configured.length === 0 ? (
          <div style={{ color: FG_DIM, fontSize: 11, fontStyle: "italic" }}>
            No MCP servers registered for the agent yet — add one below.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {configured.map((srv) => (
              <div
                key={srv.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--phn-surface-bg, #181818)",
                  border: `1px solid ${BORDER}`,
                  borderRadius: 4,
                  padding: "7px 10px",
                }}
              >
                {/* enabled checkbox */}
                <input
                  type="checkbox"
                  checked={!!srv.enabled}
                  onChange={() => onToggleEnabled(srv)}
                  style={{ accentColor: ACCENT, cursor: "pointer", flexShrink: 0 }}
                  title={srv.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: FG_ACTIVE, fontSize: 11, fontFamily: M }}>{srv.id}</span>
                  <span style={{ color: FG_DIM, fontSize: 10, marginLeft: 6 }}>{srv.transport}</span>
                  {!srv.enabled && (
                    <span style={{ color: FG_DIM, fontSize: 9, marginLeft: 6, fontStyle: "italic" }}>disabled</span>
                  )}
                </div>
                <button
                  onClick={() => onRemoveFromAgent(srv)}
                  style={{
                    background: "transparent",
                    border: `1px solid ${BORDER}`,
                    color: FG_DIM,
                    padding: "3px 8px",
                    borderRadius: 3,
                    fontFamily: M,
                    fontSize: 10,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  title="Remove from agent config"
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${BORDER}`, marginBottom: 16 }} />

      <p style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.7, marginBottom: 18 }}>
        Curated list of popular MCP (Model Context Protocol) servers that extend Claude Code. Click <strong style={{ color: ACCENT }}>install</strong> and the app runs <code style={{ background: "var(--phn-page-bg, #0a0a0a)", padding: "1px 4px", borderRadius: 2 }}>claude mcp add ...</code> for you. Or click <strong>copy</strong> to paste the command into a pane manually. Click <strong style={{ color: ACCENT }}>+ agent</strong> to register the server directly with the native agent. <strong>Restart any open Claude sessions</strong> after install for them to pick up the new MCP.
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
              <button
                onClick={() => openExternal(mcp.docs)}
                style={{ color: FG_DIM, fontSize: 10, textDecoration: "none", background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}
              >
                docs ↗
              </button>
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
                  onClick={() => onAddToAgent(mcp)}
                  disabled={addingId != null || !!secretPrompt || configured.some((s) => s.id === mcp.id)}
                  style={{
                    background: configured.some((s) => s.id === mcp.id) ? "#34D399" : "transparent",
                    border: `1px solid ${configured.some((s) => s.id === mcp.id) ? "#34D399" : BORDER}`,
                    color: configured.some((s) => s.id === mcp.id) ? "#001" : FG,
                    padding: "5px 10px",
                    borderRadius: 3,
                    fontFamily: M,
                    fontSize: 10,
                    cursor: (addingId != null || !!secretPrompt || configured.some((s) => s.id === mcp.id)) ? "default" : "pointer",
                    whiteSpace: "nowrap",
                    opacity: addingId === mcp.id ? 0.6 : 1,
                  }}
                  title={
                    configured.some((s) => s.id === mcp.id)
                      ? "Already registered for the agent"
                      : "Register this server with the native agent"
                  }
                >
                  {addingId === mcp.id ? "adding…"
                    : configured.some((s) => s.id === mcp.id) ? "✓ agent"
                    : "+ agent"}
                </button>
                <button
                  onClick={() => onInstall(mcp)}
                  disabled={installState[mcp.id] === "installing"}
                  style={{
                    background:
                      installState[mcp.id] === "ok" ? "#34D399"
                      : installState[mcp.id] === "error" ? "#e08784"
                      : ACCENT,
                    border: `1px solid ${
                      installState[mcp.id] === "ok" ? "#34D399"
                      : installState[mcp.id] === "error" ? "#e08784"
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
        <button onClick={() => openExternal("https://github.com/modelcontextprotocol/servers")} style={{ color: ACCENT, textDecoration: "none", background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>
          github.com/modelcontextprotocol/servers ↗
        </button>
        . The standard Claude Code install pattern is{" "}
        <code style={{ background: "var(--phn-surface-bg, #181818)", padding: "1px 4px", borderRadius: 2 }}>claude mcp add &lt;name&gt; -- npx -y &lt;package&gt;</code>.
      </div>

      {/* Masked access-token prompt (replaces window.prompt for secrets). */}
      <Modal open={!!secretPrompt} title="Access token" onClose={() => closeSecret(null)} width={420}>
        <p style={{ color: FG_DIM, fontSize: 11, lineHeight: 1.5, marginTop: 0 }}>
          {secretPrompt?.label}
        </p>
        <input
          type="password"
          autoFocus
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") closeSecret(secretValue); }}
          placeholder="Paste token — stored in the OS keychain, never localStorage"
          style={{
            width: "100%", boxSizing: "border-box",
            background: "var(--phn-page-bg, #0a0a0a)", border: `1px solid ${BORDER}`,
            borderRadius: 4, color: FG_ACTIVE, padding: "7px 9px", fontSize: 12,
            fontFamily: M, outline: "none",
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button
            onClick={() => closeSecret(null)}
            style={{ background: "transparent", border: `1px solid ${BORDER}`, color: FG, padding: "6px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: M }}
          >
            skip
          </button>
          <button
            onClick={() => closeSecret(secretValue)}
            style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: "#001", padding: "6px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: M }}
          >
            set token
          </button>
        </div>
      </Modal>
    </Modal>
  );
}
