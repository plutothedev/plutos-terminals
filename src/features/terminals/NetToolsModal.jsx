// (C)
// Network tools (MobaXterm-style toolbox): ping, traceroute, TCP port scan and
// DNS lookup against a host. Each runs in Rust (see netools.rs) — ping/tracert
// shell out to the OS tools; port scan + DNS are pure Rust. Output is shown
// raw/monospace. Host is validated backend-side, so no injection risk.
import { useEffect, useState } from "react";
import { invoke } from "@backend";
import Modal from "../../components/Modal.jsx";
import { Button, Input, Chip } from "../../components/ui.jsx";

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
      <div style={{ display: "flex", gap: "var(--phn-sp-1)", marginBottom: "var(--phn-sp-3)" }}>
        {TOOLS.map((t) => (
          <Chip
            key={t.id}
            active={tool === t.id}
            onClick={() => setTool(t.id)}
            style={{ flex: 1, textAlign: "center" }}
          >
            {t.label}
          </Chip>
        ))}
      </div>

      <div style={{ display: "flex", gap: "var(--phn-sp-2)" }}>
        <Input
          mono
          autoFocus
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
          placeholder="host or IP  (e.g. github.com or 10.0.0.5)"
        />
        <Button variant="primary" onClick={run} disabled={busy || !host.trim()}>
          {busy ? "running…" : "run ▶"}
        </Button>
      </div>

      {tool === "ports" && (
        <div style={{ marginTop: "var(--phn-sp-2)" }}>
          <Input
            mono
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            placeholder="ports — e.g. 22,80,443 or 1-1024"
          />
          <div style={{ fontSize: "var(--phn-fs-2xs)", color: DIM, marginTop: 3 }}>Comma list or ranges; capped at 256 ports per scan.</div>
        </div>
      )}

      <pre
        style={{
          marginTop: "var(--phn-sp-3)", padding: "var(--phn-sp-3)", borderRadius: "var(--phn-r-md)", minHeight: 120, maxHeight: "42vh",
          overflow: "auto", background: "var(--phn-page-bg, #1c1c1c)",
          border: "1px solid var(--phn-surface-border, #2a2a2a)",
          color: "var(--phn-text-fg)", fontFamily: "var(--phn-mono-font)",
          fontSize: "var(--phn-fs-sm)", lineHeight: "var(--phn-lh)", whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}
      >
        {out || <span style={{ color: DIM }}>Pick a tool, enter a host, and hit run.</span>}
      </pre>
    </Modal>
  );
}
