// (C)
// One humanizing layer for raw errors. Backend/library failures reach the UI
// as strings like "[Session(-18)] Username/PublicKey combination invalid" or
// "The system cannot find the file specified. (os error 2)" — accurate, but
// not something to show a user untranslated. humanizeError maps the common
// classes to a short human sentence and keeps the full raw string as detail
// (toasts copy it to the clipboard; diagnostics surfaces print it).

// Rule order is load-bearing:
// - file-not-found before auth, so "No such file: password.txt" isn't read as
//   an auth failure by the "password" keyword;
// - auth before permission, so SSH's classic "Permission denied (publickey)"
//   maps to credentials, not to a filesystem ACL problem;
// - handshake before the network sentences, so "SSH handshake timed out"
//   keeps the more specific message.
const RULES = [
  [/os error 2\b|NotFound|no such file|cannot find the (file|path)/i, "File not found"],
  [/authenticat|authoriz|\bauth\b|publickey|password/i, "Authentication failed — check your credentials"],
  [/os error 5\b|access (is )?denied|permission denied/i, "Permission denied"],
  [/non-fast-forward/i, "Remote has newer changes — pull first"],
  [/handshake/i, "Could not establish the SSH connection"],
  [/connection refused/i, "Connection refused — nothing is listening at that address"],
  [/tim(ed)?[ -]?out/i, "The connection timed out"],
  [/unreachable|could not resolve|failed to resolve|name or service not known|getaddrinfo|nodename nor servname/i, "The host could not be reached"],
  [/poisoned/i, "Internal error — please retry (the app recovered a background lock)"],
];

const MAX_RAW = 160;

// humanizeError(err, ctx) -> { message, detail }
// message: short human sentence (ctx-prefixed when given), safe for a toast.
// detail: the full raw string, for clipboard copy / diagnostics surfaces.
export function humanizeError(err, ctx) {
  let raw = String(err ?? "").trim();
  // Plain objects stringify uselessly; prefer their .message when present.
  if (raw === "[object Object]" && typeof err?.message === "string") raw = err.message.trim();
  if (!raw) raw = "Unknown error";

  let message = null;
  for (const [re, human] of RULES) {
    if (re.test(raw)) { message = human; break; }
  }
  if (message == null) {
    // Unmatched: show the raw string, single-line and capped so a novel error
    // can't blow a toast up to a wall of text.
    message = raw.replace(/\s+/g, " ");
    if (message.length > MAX_RAW) message = message.slice(0, MAX_RAW - 1).trimEnd() + "…";
  }
  if (ctx) message = `${ctx}: ${message}`;
  return { message, detail: raw };
}
