// (C)
import { describe, it, expect } from "vitest";
import { visibleShares, SHARES_PAGE_SIZE } from "./sharesPage.js";

const entry = (id) => ({ id: String(id), title: `share ${id}` });
const history = (n) => Array.from({ length: n }, (_, i) => entry(i)); // append-order: 0 oldest

describe("visibleShares", () => {
  it("renders newest first (storage stays append-order)", () => {
    const h = history(3);
    const { rows } = visibleShares(h, 10);
    expect(rows.map((r) => r.id)).toEqual(["2", "1", "0"]);
    // Input untouched — shareHistory is live userSt state.
    expect(h.map((r) => r.id)).toEqual(["0", "1", "2"]);
  });

  it("caps rows at `shown` and reports the hidden remainder", () => {
    const { rows, remaining } = visibleShares(history(60), 25);
    expect(rows).toHaveLength(25);
    expect(rows[0].id).toBe("59"); // newest
    expect(rows[24].id).toBe("35");
    expect(remaining).toBe(35);
  });

  it("remaining is 0 when everything fits", () => {
    const { rows, remaining } = visibleShares(history(5), 25);
    expect(rows).toHaveLength(5);
    expect(remaining).toBe(0);
  });

  it("tolerates non-array history (mirrors SharesModal's Array.isArray guard)", () => {
    for (const bad of [undefined, null, "x", 7, {}]) {
      expect(visibleShares(bad, 25)).toEqual({ rows: [], remaining: 0 });
    }
  });

  it("tolerates garbage `shown` values without throwing or going negative", () => {
    expect(visibleShares(history(4), 0)).toEqual({ rows: [], remaining: 4 });
    expect(visibleShares(history(4), -3).rows).toHaveLength(0);
    expect(visibleShares(history(4), NaN).rows).toHaveLength(0);
    expect(visibleShares(history(4), 2.9).rows).toHaveLength(2);
  });

  it("page size constant is a sane positive integer", () => {
    expect(Number.isInteger(SHARES_PAGE_SIZE)).toBe(true);
    expect(SHARES_PAGE_SIZE).toBeGreaterThan(0);
  });
});
