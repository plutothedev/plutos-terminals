// (C)
// AI session summary — sends the active terminal's recent output to the active
// LLM and shows a concise summary (what happened, key results, anything that
// errored, suggested next step). Same Rust llm_complete path as ErrorExplainer
// (the key never hits a browser request).
import { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import { Button } from "../../components/ui.jsx";
import { noModelMessage, resolveActiveLLM } from "./providers.js";
import { llmStream } from "./llmStream.js";
import { readUserSt } from "./storageKeys.js";
import { humanizeError } from "./errorText.js";
import { handoffPayload, handoffPreview, handoffTargets } from "./handoffText.js";
import { getLiveTabIds, writeToTab } from "./ptyBridge.js";
import { getEntry } from "./paneRegistry.js";
// The agent a pane reports is running there (OSC 7501: idle, working or
// blocked; paneAgent.js), or null. A shell at its prompt turns bracketed paste
// on too, so that alone is no sign a pasted summary will be read rather than
// run.
function agentIn(paneId) {
  try {
    return getEntry(paneId)?.agent?.runningAgent() || null;
  } catch {
    return null;
  }
}

// Whether pane `paneId` is waiting on an answer: its agent reports it is
// blocked, or the pane shows "waiting" because the screen holds a dialog the
// agent did not report.
function waitingIn(paneId) {
  try {
    return agentIn(paneId)?.state === "blocked" || getEntry(paneId)?.agent?.shown === "waiting";
  } catch {
    return true;
  }
}

// Whether pane `paneId` can take the summary now: an agent reports it is
// running there and the pane is not waiting on an answer (a pending dialog
// would take the paste's keys as its answer), and its program has turned
// bracketed paste on (xterm tracks it from the program's own `CSI ? 2004 h`).
function acceptsPaste(paneId) {
  try {
    return !!agentIn(paneId) && !waitingIn(paneId) && !!getEntry(paneId)?.term?.modes?.bracketedPasteMode;
  } catch {
    return false;
  }
}

const SYSTEM =
  "You are summarizing a terminal session for an engineer. From the recent " +
  "terminal output, produce: (1) a 1-2 sentence summary of what was done, " +
  "(2) key results or state changes as short bullets, (3) anything that errored " +
  "or looks wrong, and (4) one suggested next step. Be concise; skip prompts/noise.";

export default function SessionSummary({ open, text, sourceId = null, panels = [], onClose }) {
  const [answer, setAnswer] = useState("");
  // Handoff: the summary pasted into another pane as a prepared prompt.
  const [target, setTarget] = useState("");
  const [sent, setSent] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modelLabel, setModelLabel] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (!open) { ran.current = false; setAnswer(""); setError(null); setTarget(""); setSent(""); return; }
    if (ran.current) return;
    ran.current = true;
    const body = (text || "").trim();
    if (!body) { setLoading(false); setError("Nothing in this terminal to summarize yet."); return; }
    const llmState = readUserSt();
    const llm = resolveActiveLLM(llmState);
    if (!llm) { setLoading(false); setError(noModelMessage(llmState)); return; }
    setModelLabel(llm.model);
    setLoading(true); setError(null); setAnswer("");
    // Streaming (P3-T2): deltas render as they arrive — the spinner clears on
    // the first token. Cleanup CANCELS the stream AND resets the ran-guard so
    // StrictMode's dev double-mount re-runs cleanly instead of dead-modaling
    // (plan audit M3); a real close also stops provider-side generation.
    // `cancelled` guards every continuation (stream audit W1): summarizing tab
    // B while A still streams re-runs this effect on the SAME mounted modal —
    // without the guard, A's cancelled promise still resolves with partial
    // text and clobbers B's answer (llm_stream returns Ok on cancel, not Err).
    let cancelled = false;
    const { promise, cancel } = llmStream(
      {
        kind: llm.kind, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
        model: llm.model, system: SYSTEM,
        prompt: `--- recent terminal output ---\n${body}`,
      },
      (piece) => {
        if (cancelled) return;
        setLoading(false);
        setAnswer((cur) => cur + piece);
      }
    );
    promise
      .then((t) => { if (!cancelled && typeof t === "string" && t) setAnswer(t.trim()); })
      .catch((e) => { if (!cancelled) setError(humanizeError(e).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      cancel();
      ran.current = false;
    };
  }, [open, text]);

  return (
    <Modal open={open} title="Summarize session" onClose={onClose} width={620}>
      <div style={{ fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)", marginBottom: "var(--phn-sp-2)" }}>
        {modelLabel ? `via ${modelLabel}` : "active model"}
      </div>
      <div style={{ maxHeight: "60vh", overflow: "auto", fontSize: "var(--phn-fs-sm)", lineHeight: "var(--phn-lh)", color: "var(--phn-text-fg)", whiteSpace: "pre-wrap" }}>
        {loading ? (
          <span style={{ color: "var(--phn-text-dim)" }}>Reading the terminal and summarizing…</span>
        ) : error ? (
          <span style={{ color: "var(--phn-danger)" }}>{error}</span>
        ) : (
          answer || <span style={{ color: "var(--phn-text-dim)" }}>No response.</span>
        )}
      </div>
      {answer && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--phn-sp-3)" }}>
          <Button variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText(answer)}>
            Copy
          </Button>
        </div>
      )}
      {answer && !loading && <Handoff answer={answer} sourceId={sourceId} panels={panels} target={target} setTarget={setTarget} sent={sent} setSent={setSent} />}
    </Modal>
  );
}

// Send the summary to another pane as a prepared prompt: pasted, never
// followed by Enter, so the person there reads it and sends it. The preview
// is exactly the text that is pasted (cleaned and with secrets masked), the
// target list names the machine a remote pane types into, and a pane whose
// program has not turned on bracketed paste is refused. Unless the pane is
// local and its own shell reported it is running claude, this app cannot see
// the agent there quit (a remote pane sends back no prompt marks, and an ssh
// or container typed into a local pane hides them): the person confirms it is
// still running, for that pane, first.
function runningCommand(paneId) {
  try {
    return getEntry(paneId)?.blocks?.current?.command ?? null;
  } catch {
    return null;
  }
}

function Handoff({ answer, sourceId, panels, target, setTarget, sent, setSent }) {
  const [confirmedFor, setConfirmedFor] = useState("");
  const targets = handoffTargets(panels, sourceId, getLiveTabIds(), (id) => !!agentIn(id), runningCommand);
  if (targets.length === 0) {
    return (
      <div style={{ marginTop: "var(--phn-sp-3)", fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)" }}>
        To hand this off, open a pane running an agent that reports its status (Claude Code 2.1.295 or later does).
      </div>
    );
  }
  const chosen = targets.find((t) => t.paneId === target) || null;
  const agent = chosen ? agentIn(chosen.paneId) : null;
  const ok = chosen ? acceptsPaste(chosen.paneId) : false;
  const mustConfirm = !!chosen && (!!chosen.remote || !!chosen.unverified);
  const confirmed = !!chosen && (!mustConfirm || confirmedFor === chosen.paneId);
  const preview = handoffPreview(answer);
  const send = () => {
    if (!chosen || (mustConfirm && confirmedFor !== chosen.paneId)) return;
    const payload = handoffPayload(answer, { bracketed: acceptsPaste(chosen.paneId) });
    if (!payload) return;
    setSent(writeToTab(chosen.paneId, payload) ? chosen.label : "");
  };
  return (
    <div style={{ marginTop: "var(--phn-sp-3)", borderTop: "1px solid var(--phn-surface-border, #34383F)", paddingTop: "var(--phn-sp-3)" }}>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)" }}>
        Hand off to
        <select
          value={target}
          onChange={(e) => { setTarget(e.target.value); setSent(""); setConfirmedFor(""); }}
          aria-label="Pane to hand the summary to"
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">Choose a pane</option>
          {targets.map((t) => (
            <option key={t.paneId} value={t.paneId}>{t.label}</option>
          ))}
        </select>
      </label>
      {chosen && !ok && (
        <div style={{ marginTop: "var(--phn-sp-2)", fontSize: "var(--phn-fs-xs)", color: "var(--phn-danger)" }}>
          {waitingIn(chosen.paneId)
            ? `The agent in ${chosen.label} is waiting on an answer right now, so the summary is not sent there. Answer it first.`
            : `The program in ${chosen.label} does not take pasted text safely right now (bracketed paste is off), so the summary is not sent there.`}
        </div>
      )}
      {chosen && ok && (
        <>
          <div style={{ marginTop: "var(--phn-sp-2)", fontSize: "var(--phn-fs-2xs)", color: "var(--phn-text-dim)" }}>
            Pasted into {chosen.label}, where {agent?.app || "an agent"} reports it is running, as it reads below, with secrets masked. Nothing is sent until you press Enter there. If that agent has quit since, the pane is a shell, and Enter there would run the text as commands.
          </div>
          <div style={{ marginTop: "var(--phn-sp-1)", maxHeight: "20vh", overflow: "auto", fontSize: "var(--phn-fs-xs)", whiteSpace: "pre-wrap", padding: "var(--phn-sp-2)", border: "1px solid var(--phn-surface-border, #34383F)", borderRadius: 4 }}>
            {preview}
          </div>
          {mustConfirm && (
            <label style={{ display: "flex", alignItems: "center", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-2)", fontSize: "var(--phn-fs-xs)" }}>
              <input
                type="checkbox"
                checked={confirmedFor === chosen.paneId}
                onChange={(e) => setConfirmedFor(e.target.checked ? chosen.paneId : "")}
              />
              {chosen.remote
                ? `${agent?.app || "The agent"} is still running on ${chosen.remote}. This app cannot see an agent quit on another machine.`
                : `${agent?.app || "The agent"} is still running in ${chosen.label}. This app cannot see whether it quit there (an ssh or container session, or a shell it cannot follow).`}
            </label>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "var(--phn-sp-2)", marginTop: "var(--phn-sp-2)" }}>
            {sent && <span style={{ fontSize: "var(--phn-fs-xs)", color: "var(--phn-text-dim)" }}>Pasted into {sent}. Press Enter there to send it.</span>}
            <Button size="sm" onClick={send} disabled={!confirmed}>Paste into {chosen.label}</Button>
          </div>
        </>
      )}
    </div>
  );
}
