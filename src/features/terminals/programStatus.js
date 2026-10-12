// (C)
// Program Status Protocol (OSC 7501): a program tells the terminal what it is
// doing (idle, working, done, blocked on the user, failed) instead of the
// terminal guessing from the screen. Spec revision 0.4 (2026-10-10):
// https://www.superlogical.com/rex/docs/build/program-status
// Claude Code reports through it from 2.1.295; Ghostty implements it in
// libghostty-vt (ghostty-org/ghostty PR 14560).
//
// A report is `ESC ] 7501 ; key=value:key=value ST`. xterm hands the OSC
// handler everything after `7501;`, which is what parseProgramStatus takes.
// Everything in a report is untrusted: it can come from any program in the
// pane, a remote host over SSH included. So the parser follows the spec's
// limits exactly, refuses decoded text with control characters, and the only
// thing ever sent back is the fixed support reply (programStatusReply).
//
// A pure module, so the grammar, the limits and the record rules are tested
// without xterm or a pane (programStatus.test.js).

import { isHiddenChar, isControlChar } from "./safeText.js";

export const STATES = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS = ["permission", "question", "auth"];

// Spec limits, in bytes. The body is everything after `7501;`, so the
// whole-sequence cap of 4096 loses `ESC ] 7501 ;` (7) and `ESC \` (2).
export const MAX_BODY_BYTES = 4096 - 7 - 2;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_ID_BYTES = 128;
const MAX_APP_BYTES = 32;
const MAX_ID_DEPTH = 8;
export const MAX_RECORDS = 64;

const KEY_RE = new RegExp("^[a-z]+$");
const VALUE_RE = new RegExp("^[A-Za-z0-9_.,+/=-]*$");
const SEGMENT_RE = new RegExp("^[A-Za-z0-9_.+-]{1,32}$");
const APP_RE = SEGMENT_RE;
const PROGRESS_RE = new RegExp("^[0-9]{1,3}$");

const utf8 = new TextEncoder();

function byteLength(s) {
  return utf8.encode(s).length;
}

// A control character anywhere in decoded text: C0, DEL or C1. The spec bans
// them (newline and tab included), so a message can never move the cursor,
// start an escape sequence or break a line in whatever shows it.
export function hasControlChar(s) {
  for (const ch of s) if (isControlChar(ch)) return true;
  return false;
}

// Standard base64 of UTF-8, padding optional. Returns the text, or null when
// it is not valid base64, not valid UTF-8, too long, or carries a control
// character: any of those discards the whole report.
function decodeText(encoded, maxEncoded, maxDecoded) {
  if (encoded.length > maxEncoded) return null;
  if (encoded.length % 4 === 1) return null;
  for (const ch of encoded) {
    const ok = (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "+" || ch === "/" || ch === "=";
    if (!ok) return null;
  }
  const firstPad = encoded.indexOf("=");
  if (firstPad !== -1 && encoded.slice(firstPad).replace(/=/g, "") !== "") return null;
  let bin;
  try {
    bin = atob(encoded);
  } catch {
    return null;
  }
  if (bin.length > maxDecoded) return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return hasControlChar(text) ? null : text;
}

function validId(id) {
  if (byteLength(id) > MAX_ID_BYTES) return false;
  const segments = id.split("/");
  if (segments.length > MAX_ID_DEPTH) return false;
  return segments.every((s) => SEGMENT_RE.test(s));
}

// One OSC 7501 body -> { query: true } for the support probe, { report } for
// a valid report, or null for anything the spec says to ignore. A report is
// { state, id, kind?, progress?, app?, title?, msg? }; id "" is the root.
export function parseProgramStatus(body) {
  if (typeof body !== "string") return null;
  // Characters never outnumber UTF-8 bytes, so this rejects an oversized
  // body before it is encoded.
  if (body.length > MAX_BODY_BYTES || byteLength(body) > MAX_BODY_BYTES) return null;
  if (body === "?") return { query: true };
  // No prototype, so a key such as `constructor` is only ever a pair.
  const pairs = Object.create(null);
  for (const raw of body.split(":")) {
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    // Over a limit discards the whole report (every occurrence counts, a
    // repeated key's earlier one included); outside the grammar only skips
    // the pair.
    if (byteLength(key) > MAX_KEY_BYTES) return null;
    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) continue;
    if (
      (key === "msg" && value.length > MAX_MSG_ENCODED) ||
      (key === "title" && value.length > MAX_TITLE_ENCODED) ||
      (key === "app" && value.length > MAX_APP_BYTES) ||
      (key === "id" && value.length > MAX_ID_BYTES)
    ) {
      return null;
    }
    pairs[key] = value;
  }
  const state = pairs.state;
  if (!STATES.includes(state)) return null;
  let id = "";
  if (pairs.id !== undefined) {
    if (!validId(pairs.id)) return null;
    id = pairs.id;
  }
  const report = { state, id };
  if (state === "blocked" && KINDS.includes(pairs.kind)) report.kind = pairs.kind;
  if ((state === "working" || state === "blocked") && pairs.progress !== undefined && PROGRESS_RE.test(pairs.progress)) {
    const n = Number(pairs.progress);
    if (n >= 0 && n <= 100) report.progress = n;
  }
  if (pairs.app !== undefined && APP_RE.test(pairs.app)) report.app = pairs.app;
  if (pairs.title !== undefined) {
    const title = decodeText(pairs.title, MAX_TITLE_ENCODED, MAX_TITLE_DECODED);
    if (title === null) return null;
    report.title = title;
  }
  if (pairs.msg !== undefined) {
    const msg = decodeText(pairs.msg, MAX_MSG_ENCODED, MAX_MSG_DECODED);
    if (msg === null) return null;
    report.msg = msg;
  }
  return { report };
}

// The support reply: `ESC ] 7501 ; ? ST`, the same bytes the program sent.
// Fixed, so nothing a program says is ever sent back to it.
export function programStatusReply() {
  return String.fromCharCode(27) + "]7501;?" + String.fromCharCode(27) + String.fromCharCode(92);
}

// ── Records ─────────────────────────────────────────────────────────────────
// One record per id, each report replacing its record whole. A store is a
// plain { records: Map, seq } so a pane can keep it on its registry entry.

export function createStatusStore() {
  return { records: new Map(), seq: 0 };
}

function isUnder(id, parent) {
  return parent === "" || id === parent || id.startsWith(parent + "/");
}

export function applyReport(store, report) {
  if (report.state === "clear") {
    for (const id of [...store.records.keys()]) {
      if (isUnder(id, report.id)) store.records.delete(id);
    }
    return;
  }
  store.seq += 1;
  const { id, ...fields } = report;
  store.records.delete(id);
  store.records.set(id, { ...fields, seq: store.seq });
  while (store.records.size > MAX_RECORDS) {
    let oldest = null;
    for (const [rid, rec] of store.records) {
      if (rid === id) continue;
      if (oldest === null || rec.seq < store.records.get(oldest).seq) oldest = rid;
    }
    store.records.delete(oldest);
  }
}

// Program exit, or a new shell prompt (OSC 133 A): whatever was in flight is
// over. done and error stay, so a finished run is still there to be seen.
export function endInFlight(store) {
  for (const [id, rec] of [...store.records]) {
    if (rec.state === "working" || rec.state === "blocked" || rec.state === "idle") store.records.delete(id);
  }
}

// The user has looked at the pane: done and error have been seen.
export function acknowledge(store) {
  for (const [id, rec] of [...store.records]) {
    if (rec.state === "done" || rec.state === "error") store.records.delete(id);
  }
}

export function resetStatus(store) {
  store.records.clear();
}

const RANK = { idle: 0, done: 1, working: 2, error: 3, blocked: 4 };

// The record that speaks for the pane: the most urgent, the latest on a tie.
// Its app is inherited from the nearest ancestor when it has none. null when
// the pane holds no records.
export function paneProgramStatus(store) {
  let best = null;
  let bestId = null;
  for (const [id, rec] of store.records) {
    if (best === null || RANK[rec.state] > RANK[best.state] || (RANK[rec.state] === RANK[best.state] && rec.seq > best.seq)) {
      best = rec;
      bestId = id;
    }
  }
  if (best === null) return null;
  let app = best.app;
  for (let at = bestId; app === undefined && at !== ""; ) {
    const cut = at.lastIndexOf("/");
    at = cut === -1 ? "" : at.slice(0, cut);
    app = store.records.get(at)?.app;
  }
  const status = { state: best.state, id: bestId };
  for (const key of ["kind", "progress", "title", "msg"]) {
    if (best[key] !== undefined) status[key] = best[key];
  }
  if (app !== undefined) status.app = app;
  return status;
}

// The pane activity the rest of the app understands (activityStore):
// blocked is "waiting" (needs you), working "active", done and error "done".
export function activityFor(status) {
  if (!status) return null;
  if (status.state === "blocked") return "waiting";
  if (status.state === "working") return "active";
  if (status.state === "done" || status.state === "error") return "done";
  return "idle";
}

// A program's text, ready to show as plain text outside the grid: hidden and
// control characters dropped (safeText.js), cut to `max` characters.
export function displayText(text, max = 120) {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text) {
    if (isHiddenChar(ch) || isControlChar(ch)) continue;
    out += ch;
  }
  const chars = [...out.trim()];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

// The body of a desktop notification about a pane: the app's own words, or a
// program's message labelled as the program's (`<app> says: ...`). Never the
// title: titles are the app's own and name the pane. `when` is "needs_you" or
// "finished"; `status` may be null (no report, the prompt detector's notice).
export function statusNotice(status, when) {
  const who = displayText(status?.app || "", 32) || "The program";
  const msg = displayText(status?.msg || "", 160);
  if (msg) return `${who} says: ${msg}`;
  if (when === "needs_you") {
    if (status?.kind === "question") return `${who} has a question for you`;
    if (status?.kind === "auth") return `${who} asks you to sign in`;
    return "Waiting for your approval";
  }
  return status?.state === "error" ? `${who} stopped with an error` : "Done";
}
