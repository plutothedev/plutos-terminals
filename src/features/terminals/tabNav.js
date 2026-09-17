// (C)
// Tab-strip navigation, the sibling of paneNav.js (which navigates BETWEEN
// panes inside one tab). Pure index arithmetic over a panel's `tabs` array, so
// the keybinding dispatcher, the Terminal menu and the command palette all
// resolve "next tab" the same way instead of each re-deriving it.
//
// Audit A11Y-05: before this there was no next/previous/go-to-tab action in
// KEY_ACTIONS at all, so with five tabs open the only non-mouse route back to
// tab 1 was Ctrl+Shift+W four times, killing four live PTYs.

// The id `delta` steps away from `activeTabId`, wrapping at both ends. Wrapping
// is deliberate: the tab strip is a ring in every terminal that has this
// binding, and a next-tab that dead-ends on the last tab makes the keystroke
// feel broken with many agent tabs open.
export function nextTabId(tabs, activeTabId, delta) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (list.length === 0) return null;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const cur = list.findIndex((t) => t && t.id === activeTabId);
  // Unknown active tab (stale activeTabId) counts as position 0, so the first
  // press still moves somewhere sensible rather than doing nothing.
  const from = cur >= 0 ? cur : 0;
  if (step === 0) return list[from]?.id ?? null;
  const n = list.length;
  const idx = (((from + step) % n) + n) % n; // JS % keeps the sign; force 0..n-1
  return list[idx]?.id ?? null;
}

// The id at a 0-based index, or null when the strip is shorter than that.
// Out-of-range is a NO-OP by design, not a clamp to the last tab: with a dozen
// agent tabs open, "9" quietly meaning "whatever is last" would move focus
// somewhere the user did not ask for and could not predict.
export function tabIdAt(tabs, index) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  return list[index]?.id ?? null;
}
