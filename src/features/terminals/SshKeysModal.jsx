// (C)
// SSH key manager (Termius/MobaXterm parity). Lists keypairs in ~/.ssh, copies
// a public key to paste into a server's authorized_keys, and generates new keys
// via ssh-keygen. Private key material is never read into the UI.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../../components/Modal.jsx";
import { useToast } from "../../components/Toast.jsx";

const ACCENT = "var(--phn-link, #4aa8c0)";
const DIM = "var(--phn-text-dim, #888)";

export default function SshKeysModal({ open, onClose }) {
  const toast = useToast();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [gen, setGen] = useState(false);
  const [name, setName] = useState("id_pluto");
  const [keyType, setKeyType] = useState("ed25519");
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    invoke("ssh_keys_list")
      .then((k) => setKeys(Array.isArray(k) ? k : []))
      .catch((e) => toast.error(`Couldn't list keys: ${e}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => { if (open) { refresh(); setGen(false); } }, [open]); // eslint-disable-line

  const copyPub = (k) => {
    navigator.clipboard?.writeText(k.public_key);
    toast.success(`Copied ${k.name}.pub — paste into the server's ~/.ssh/authorized_keys`);
  };

  const generate = async () => {
    if (!name.trim()) { toast.error("Name the key first."); return; }
    setBusy(true);
    try {
      const k = await invoke("ssh_key_generate", {
        name: name.trim(), keyType, comment: comment.trim(), passphrase,
      });
      toast.success(`Generated ${k.name} (${k.key_type}).`);
      setGen(false); setPassphrase(""); setComment("");
      refresh();
    } catch (e) {
      toast.error(`ssh-keygen: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="SSH keys" onClose={onClose} width={620}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: DIM }}>~/.ssh — {keys.length} key{keys.length === 1 ? "" : "s"}</span>
        <button onClick={() => setGen((v) => !v)} style={primaryBtn}>{gen ? "Cancel" : "Generate new key"}</button>
      </div>

      {gen && (
        <div style={{ border: `1px solid ${ACCENT}`, borderRadius: 6, padding: 12, marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="key name (e.g. id_pluto)" style={input} />
            <select value={keyType} onChange={(e) => setKeyType(e.target.value)} style={{ ...input, flex: "0 0 130px" }}>
              <option value="ed25519">ed25519</option>
              <option value="rsa">rsa 4096</option>
            </select>
          </div>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="comment (optional, e.g. you@host)" style={input} />
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="passphrase (optional, recommended)" style={input} />
          <button onClick={generate} disabled={busy} style={{ ...primaryBtn, alignSelf: "flex-start" }}>
            {busy ? "Generating…" : "Create keypair"}
          </button>
        </div>
      )}

      <div style={{ maxHeight: "52vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {loading ? (
          <div style={{ color: DIM, fontSize: 12 }}>Loading…</div>
        ) : keys.length === 0 ? (
          <div style={{ color: DIM, fontSize: 12 }}>No keys in ~/.ssh yet. Generate one above.</div>
        ) : (
          keys.map((k) => (
            <div key={k.private_path} style={{ border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 6, padding: "8px 12px", background: "var(--phn-surface-bg, #242424)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--phn-text-fg, #d4d4d4)" }}>🔑 {k.name}</span>
                <span style={{ fontSize: 10, color: ACCENT }}>{k.key_type}</span>
                {k.comment && <span style={{ fontSize: 10, color: DIM }}>{k.comment}</span>}
                <span style={{ flex: 1 }} />
                <button onClick={() => copyPub(k)} style={ghostBtn}>Copy public key</button>
              </div>
              <div style={{ marginTop: 6, fontFamily: "'MesloLGS NF', monospace", fontSize: 10.5, color: DIM, wordBreak: "break-all", lineHeight: 1.4 }}>
                {k.public_key.length > 120 ? k.public_key.slice(0, 120) + "…" : k.public_key}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

const input = {
  flex: 1, background: "var(--phn-page-bg, #1c1c1c)",
  border: "1px solid var(--phn-surface-border, #2a2a2a)", borderRadius: 4,
  color: "var(--phn-text-fg, #d4d4d4)", padding: "6px 8px", fontSize: 12,
  fontFamily: "var(--phn-ui-font)", outline: "none",
};
const primaryBtn = {
  background: ACCENT, border: "none", color: "#06223a", borderRadius: 5,
  padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--phn-ui-font)",
};
const ghostBtn = {
  background: "transparent", border: `1px solid ${ACCENT}`, color: ACCENT,
  padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--phn-ui-font)",
};
