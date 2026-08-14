// (C)
import { describe, test, expect } from "vitest";
import { TOUR_STEPS, TOUR_CHAPTERS } from "./tourSteps.js";

describe("tour step data integrity", () => {
  test("has ~25 steps and every step is complete", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(24);
    for (const s of TOUR_STEPS) {
      expect(s.id, JSON.stringify(s)).toBeTruthy();
      expect(TOUR_CHAPTERS).toContain(s.chapter);
      expect(s.title).toBeTruthy();
      expect(s.body?.length, s.id).toBeGreaterThan(40);
      if (s.target !== null) {
        expect(s.target, s.id).toMatch(/^\[data-tour="[a-z-]+"\]$/);
        expect(s.useCase, s.id).toMatch(/^Use it when/);
      }
    }
  });

  test("ids are unique", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("chapters appear contiguously and in TOUR_CHAPTERS order", () => {
    const seen = [];
    for (const s of TOUR_STEPS) {
      if (seen[seen.length - 1] !== s.chapter) seen.push(s.chapter);
    }
    expect(seen).toEqual(TOUR_CHAPTERS.filter((c) => seen.includes(c)));
    expect(new Set(seen).size).toBe(seen.length); // no chapter splits
  });

  test("no em dashes in user-facing copy (pluto rule)", () => {
    for (const s of TOUR_STEPS) {
      const text = [s.title, s.body, s.useCase || ""].join(" ");
      expect(text.includes("—"), s.id).toBe(false);
    }
  });
});
