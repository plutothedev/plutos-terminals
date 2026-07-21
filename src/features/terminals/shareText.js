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

export function buildShare(kind, rawText, dateStamp) {
  const hits = scanSecrets(rawText);
  const masked = maskSecrets(rawText, hits);
  const ext = kind === "transcript" ? "md" : "txt";
  const filename = `plutos-terminal-share-${dateStamp}.${ext}`;
  return { filename, masked, hits };
}
