// (C)
// A session summary handed to another pane as a prepared prompt. The summary
// is model output written from another session's transcript, which anything
// in that session could have steered, so before it reaches a terminal it is
// reduced to plain text that cannot act on its own:
//
// - no control characters but newline and tab: no carriage return to submit
//   it, no ESC to end a bracketed paste early or start an escape sequence,
//   no DEL and no C1;
// - no invisible or direction-changing characters;
// - at most MAX_HANDOFF_CHARS characters;
// - when the target has not turned on bracketed paste, newlines become
//   spaces, because a bare newline there would run each line as a command.
//
// It is pasted, never followed by Enter: the person sends it.

import { isHiddenChar, isControlChar } from "./safeText.js";
import { scanSecrets, maskSecrets } from "./secretScan.js";
import { getLayout, leafIds } from "./splitTree";
import { paneAddress, paneSessionLabel, paneSpawnConfig } from "./activePane.js";

export const MAX_HANDOFF_CHARS = 8000;

const NEWLINE = 10;
const TAB = 9;

export function handoffText(text, { bracketed }) {
  if (typeof text !== "string") return "";
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count >= MAX_HANDOFF_CHARS) break;
    const c = ch.codePointAt(0);
    if (isHiddenChar(ch)) continue;
    if (c === NEWLINE) {
      out += bracketed ? ch : " ";
    } else if (c === TAB) {
      out += ch;
    } else if (isControlChar(ch)) {
      continue;
    } else {
      out += ch;
    }
    count += 1;
  }
  return out.trim();
}

// The bytes for a target pane: the cleaned text, its secrets masked
// (secretScan.js, the same masking Share uses), inside a bracketed paste.
// null when the target's program has not turned bracketed paste on: then a
// paste is plain typing, and a newline or a single key could act on its own.
export function handoffPayload(text, { bracketed }) {
  if (!bracketed) return null;
  const clean = handoffText(text, { bracketed: true });
  if (!clean) return null;
  const masked = maskSecrets(clean, scanSecrets(clean));
  const ESC = String.fromCharCode(27);
  return `${ESC}[200~${masked}${ESC}[201~`;
}

// Whether a command a local shell reported running (its nonce-gated
// PlutoCmd hook) starts an agent this app knows reports its own status:
// `claude`, by name or path, after any VAR=value assignments. zsh reports
// the whole line typed, so a line that chains or nests commands (`claude &&
// ssh prod` runs ssh once claude quits) is not taken as an agent.
const ASSIGNMENT = new RegExp("^[A-Za-z_][A-Za-z0-9_]*=");
const BLANKS = new RegExp("[ " + String.fromCharCode(9) + "]+");
const CHAINS = new RegExp("[;&|()`" + String.fromCharCode(10, 13) + "]|[$][(]");
export function runsKnownAgent(command) {
  if (typeof command !== "string" || CHAINS.test(command)) return false;
  const first = command.trim().split(BLANKS).find((w) => !ASSIGNMENT.test(w)) || "";
  return first.split("/").pop() === "claude";
}

// What the person sees before sending: exactly the text inside the paste.
export function handoffPreview(text) {
  const clean = handoffText(text, { bracketed: true });
  return maskSecrets(clean, scanSecrets(clean));
}

// The panes a summary can go to: live terminal panes other than the one it
// came from where `isAgentPane` says an agent is running, labelled as the
// phone's session list labels them (with the address a remote pane types
// into). A shell turns bracketed paste on at its prompt too, so that alone
// does not make a pane safe to paste a summary into. A remote pane (SSH or
// serial) also carries `remote`, its address: no prompt marks come back from
// it, so a report that an agent is running there outlives the agent. A local
// pane whose shell did not report it is running a known agent (see
// runsKnownAgent; `localCommand(id)` is that report) carries `unverified`:
// an ssh, a container or a shell without prompt marks may be in between.
export function handoffTargets(panels, sourceId, liveIds, isAgentPane = () => false, localCommand = () => null) {
  const live = new Set(liveIds || []);
  const out = [];
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      if (tab.home || tab.notebook || tab.rdp || tab.vnc) continue;
      const ids = leafIds(getLayout(tab));
      ids.forEach((id, i) => {
        if (id === sourceId || !live.has(id) || !isAgentPane(id)) return;
        const label = paneSessionLabel(tab, id, i, ids.length);
        const remote = paneAddress(paneSpawnConfig(tab, id));
        if (remote) out.push({ paneId: id, label, remote });
        else if (runsKnownAgent(localCommand(id))) out.push({ paneId: id, label });
        else out.push({ paneId: id, label, unverified: true });
      });
    }
  }
  return out;
}
