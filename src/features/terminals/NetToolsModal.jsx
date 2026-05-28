// (C)
// Network tools (MobaXterm-style toolbox): ping, traceroute, TCP port scan and
// DNS lookup against a host. Each runs in Rust (see netools.rs) — ping/tracert
// shell out to the OS tools; port scan + DNS are pure Rust. Output is shown
// raw/monospace. Host is validated backend-side, so no injection risk.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../../components/Modal.jsx";

const DIM = "var(--phn-text-dim, #888)";
const TOOLS = [
  { id: "ping", label: "Ping" },
  { id: "traceroute", label: "Traceroute" },
  { id: "ports", label: "Port scan" },
  { id: "dns", label: "DNS lookup" },
];

export default function NetToolsModal({ open, initialHost, onClose }) {
  const [tool, setTool] = useState("ping");
  const [host, setHost] = useState("");
  const [ports, setPorts] = useState("22,80,443,3389,8080,5432,3306,6379");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  // Seed the host from the active SSH session each time the modal opens.
  useEffect(() => {
    if (open) { setHost(initialHost || ""); setOut(""); }
  }, [open, initialHost]);

  const run = async () => {
    const h = host.trim();
    if (!h) { setOut("Enter a host first."); return; }
    setBusy(true);
    setOut(`Running ${tool} on ${h}…`);
    try {
      if (tool === "ping") {
        setOut(await invoke("net_ping", { host: h }));
      } else if (tool === "traceroute") {
        setOut(await invoke("net_traceroute", { host: h }));
      } else if (tool === "dns") {
        const ips = await invoke("net_dns", { host: h });
        setOut(`${h} resolves to:\n` + ips.map((ip) => `  • ${ip}`).join("\n"));
      } else if (tool === "ports") {
        const openPorts = await invoke("net_port_scan", { host: h, ports });
        setOut(
          openPorts.length
            ? `Open TCP ports on ${h}:\n` + openPorts.map((p) => `  • ${p}`).join("\n")
            : `No open ports found on ${h} (from: ${ports}).`
        );
      }
    } catch (e) {
      setOut(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Network tools" onClose={onClose} width={620}>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            style={{
              flex: 1,
              background: tool === t.id ? "var(--phn-accent-subtle, rgba(74,168,192,0.18))" : "transparent",
              border: `1px solid ${tool === t.id ? "var(--phn-link, #4aa8c0)" : "var(--phn-surface-border, #2a2a2a)"}`,
              color: tool === t.id ? "var(--phn-link, #4aa8c0)" : "var(--phn-text-fg, #d4d4d4)",
              borderRadius: 4, padding: "6px 8px", fontSize: 11.5, cursor: "pointer",
              fontFamily: "var(--phn-ui-font)", fontWeight: tool === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          autoFocus
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
          placeholder="host or IP  (e.g. github.com or 10.0.0.5)"
          style={input}
        />
        <button onClick={run} disabled={busy || !host.trim()} style={{ ...primaryBtn, opacity: busy || !host.trim() ? 0.5 : 1 }}>
          {busy ? "running…" : "run ▶"}
        </button>
      </div>

      {tool === "ports" && (
        <div style={{ marginTop: 8 }}>
          <input
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            placeholder="ports — e.g. 22,80,443 or 1-1024"
            style={{ ...input, width: "100%", boxSizing: "border-box", fontFamily: "'MesloLGS NF', monospace", fontSize: 11.5 }}
          />
          <div style={{ fontSize: 10, color: DIM, marginTop: 3 }}>Comma list or ranges; capped at 256 ports per scan.</div>
        </div>
      )}

      <pre
        style={{
          marginTop: 12, padding: "10px 12px", borderRadius: 6, minHeight: 120, maxHeight: "42vh",
          overflow: "auto", background: "var(--phn-page-bg, #1c1c1c)",
          border: "1px solid var(--phn-surface-border, #2a2a2a)",
          color: "var(--phn-text-fg, #d4d4d4)", fontFamily: "'MesloLGS NF', monospace",
          fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}
      >
        {out || <span style={{ color: DIM }}>Pick a tool, enter a host, and hit run.</span>}
      </pre>
    </Modal>
  );
}

const input = {
  flex: 1, background: "var(--phn-page-bg, #1c1c1c)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 4,
  color: "var(--phn-text-fg, #d4d4d4)", padding: "7px 9px", fontSize: 12.5,
  fontFamily: "var(--phn-ui-font)", outline: "none",
};
const primaryBtn = {
  background: "var(--phn-link, #4aa8c0)", border: "1px solid var(--phn-link, #4aa8c0)",
  color: "#06223a", padding: "6px 16px", borderRadius: 4, fontSize: 11.5, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--phn-ui-font)", whiteSpace: "nowrap",
};
