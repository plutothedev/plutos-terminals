// (C)
// Pure display-slicing for the "My shares" list (SharesModal). shareHistory is
// stored append-order (oldest first, see ShareModal's saveUser append) and is
// never reordered in storage — this helper only decides what to RENDER:
// newest first, capped, with a "show more" remainder count. Deferred from the
// 2026-08-03 forward-risk review (shares-list pagination).

export const SHARES_PAGE_SIZE = 25;

/**
 * @param {Array|any} history userSt.shareHistory (append-order; tolerates non-array)
 * @param {number} shown how many rows the modal is currently willing to render
 * @returns {{rows: Array, remaining: number}} rows newest-first, remaining = hidden count
 */
export function visibleShares(history, shown) {
  const list = Array.isArray(history) ? history : [];
  const cap = Math.max(0, Number.isFinite(shown) ? Math.floor(shown) : 0);
  // slice() before reverse(): reverse() mutates, and `history` is live userSt.
  const newestFirst = list.slice().reverse();
  return {
    rows: newestFirst.slice(0, cap),
    remaining: Math.max(0, list.length - cap),
  };
}
