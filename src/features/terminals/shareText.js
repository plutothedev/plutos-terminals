// (C)
// Stream D: pure share-text assembly for the gist share flow. Reuses Stream
// A's secretScan.js to mask the preview before anything can be uploaded.
//
// AUDIT-CRITICAL: filename is CONTENT-INDEPENDENT. It is never derived from
// rawText/command/title -- only from `kind` and the injected `dateStamp` --
// because the gist filename rides in the same POST body as the content, and
// a raw-title-derived filename (e.g. slugifying a command like
// `curl -H "Authorization: Bearer sk-..."`) would leak a secret through the
// filename even when the content itself is masked. There is deliberately no
// slugFilename helper: the fixed naming scheme removes that whole
// title-sanitization surface (and the leak class it was one bug away from).
//
// dateStamp is an INJECTED 3rd argument (a "YYYY-MM-DD" string), never
// computed in here with `new Date()` -- this module must stay a pure,
// deterministic function of its inputs (same contract as the injected-`now`
// pattern used on the Rust side).

import { scanSecrets, maskSecrets } from "./secretScan.js";

// Release-audit fix: the share pipeline had no size bound anywhere — a
// multi-day transcript ran unbounded through the scan, the preview <pre>, and
// the gist POST (30s reqwest timeout + GitHub's own gist ceiling). The upload
// text is now capped here, INSIDE buildShare, so the load-bearing
// preview===upload invariant is untouched. Mask runs BEFORE the cut (same
// ordering rule as the agent-context fix): the cut can only ever bisect a
// placeholder, never strand a raw secret fragment the scanner can't match.
// The cut keeps the TAIL — for a terminal transcript the newest output is
// what the user is sharing; the dropped part is the oldest.
export const SHARE_CAP = 256 * 1024; // chars of masked upload text
const TRUNC_NOTE =
  "[truncated: content exceeded the share size cap — showing the most recent portion]\n";

// Tail-safe slice: never strand a LOW surrogate at the start of the kept tail.
function tailSlice(s, n) {
  if (s.length <= n) return s;
  let start = s.length - n;
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return s.slice(start);
}

export function buildShare(kind, rawText, dateStamp) {
  const hits = scanSecrets(rawText);
  let masked = maskSecrets(rawText, hits);
  const truncated = masked.length > SHARE_CAP;
  if (truncated) masked = TRUNC_NOTE + tailSlice(masked, SHARE_CAP);
  const ext = kind === "transcript" ? "md" : "txt";
  const filename = `plutos-terminal-share-${dateStamp}.${ext}`;
  return { filename, masked, hits, truncated };
}
