// (C)
// Characters that change how text looks without showing themselves: every
// Unicode format character (category Cf: bidi embeddings, overrides and
// isolates, marks, zero-width characters, the word joiner, the BOM, the tag
// characters U+E0000 to U+E007F), the line and paragraph separators,
// variation selectors, Hangul fillers, and lone surrogates (which also break
// serialization). Text a program or a model wrote is shown or pasted only
// with these removed, so it reads as what it says.

const FORMAT_RE = new RegExp(String.fromCharCode(92) + "p{Cf}", "u");

export function isHiddenChar(ch) {
  const c = ch.codePointAt(0);
  if (FORMAT_RE.test(ch)) return true;
  if (c === 0x2028 || c === 0x2029) return true;
  if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef)) return true;
  if (c === 0x115f || c === 0x1160 || c === 0x3164 || c === 0xffa0) return true;
  if (c >= 0xd800 && c <= 0xdfff) return true;
  return false;
}

// C0, DEL and C1.
export function isControlChar(ch) {
  const c = ch.codePointAt(0);
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
}
