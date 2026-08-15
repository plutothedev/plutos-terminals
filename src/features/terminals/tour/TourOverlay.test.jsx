// (C)
// @vitest-environment jsdom
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TourOverlay from "./TourOverlay.jsx";

const STEPS = [
  { id: "a", chapter: "One", target: null, title: "A", body: "aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa" },
  { id: "b", chapter: "One", target: '[data-tour="exists"]', title: "B", body: "bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb", useCase: "Use it when: testing." },
  { id: "c", chapter: "Two", target: '[data-tour="missing"]', title: "C", body: "cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc", useCase: "Use it when: never." },
  { id: "d", chapter: "Two", target: null, title: "D", body: "dddd dddd dddd dddd dddd dddd dddd dddd dddd dddd" },
];
const CHAPTERS = ["One", "Two"];

beforeEach(() => {
  document.body.innerHTML = '<div data-tour="exists">x</div>';
});

function mount(onClose = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(<TourOverlay open steps={STEPS} chapters={CHAPTERS} ctx={{}} onClose={onClose} />, { container: host });
  return onClose;
}

describe("TourOverlay", () => {
  test("renders the first step title and progress", () => {
    mount();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  test("Next advances; a missing target auto-skips forward", async () => {
    mount();
    fireEvent.click(screen.getByText("Next")); // a -> b (exists)
    expect(await screen.findByText("B")).toBeTruthy();
    fireEvent.click(screen.getByText("Next")); // b -> c (missing) -> d
    expect(await screen.findByText("D")).toBeTruthy();
  });

  test("Escape ends the tour via onClose", () => {
    const onClose = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("chapter jump goes to the first step of that chapter, skipping missing targets", async () => {
    mount();
    fireEvent.click(screen.getByText("Chapters"));
    fireEvent.click(screen.getByText("Two")); // first of Two = c (missing) -> d
    expect(await screen.findByText("D")).toBeTruthy();
  });

  test("Finish on the last step closes as completed", async () => {
    const onClose = mount();
    fireEvent.click(screen.getByText("Chapters"));
    fireEvent.click(screen.getByText("Two"));
    await screen.findByText("D");
    fireEvent.click(screen.getByText("Finish"));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  test("onClose fires exactly once per open (double Finish / key repeat)", async () => {
    const onClose = mount();
    fireEvent.click(screen.getByText("Chapters"));
    fireEvent.click(screen.getByText("Two"));
    await screen.findByText("D");
    fireEvent.click(screen.getByText("Finish"));
    fireEvent.click(screen.getByText("Finish"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("handled keys stop propagating past the tour", () => {
    mount();
    const leak = vi.fn();
    document.addEventListener("keydown", leak); // bubble target beneath the overlay
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    document.removeEventListener("keydown", leak);
    expect(leak).not.toHaveBeenCalled();
  });

  test("Tab is trapped inside the card — focus can never reach chrome beneath", async () => {
    document.body.innerHTML = '<div data-tour="exists">x</div><button id="outside">chrome btn</button>';
    mount();
    // Focus something OUTSIDE the card (simulates the pre-trap escape route),
    // then Tab: the trap must pull focus back into the card.
    document.getElementById("outside").focus();
    fireEvent.keyDown(window, { key: "Tab" });
    const card = document.querySelector(".phn-tour-card");
    expect(card.contains(document.activeElement)).toBe(true);
    // Cycling stays inside across many Tabs, both directions.
    for (let k = 0; k < 10; k++) fireEvent.keyDown(window, { key: "Tab" });
    expect(card.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(card.contains(document.activeElement)).toBe(true);
  });

  test("a backward skip hitting a missing-target step 0 flips forward instead of freezing", async () => {
    const steps = [
      { id: "m0", chapter: "One", target: '[data-tour="missing"]', title: "M0", body: "mmmm mmmm mmmm mmmm mmmm mmmm mmmm mmmm mmmm mmmm", useCase: "Use it when: never." },
      { id: "ok", chapter: "One", target: '[data-tour="exists"]', title: "OK", body: "oooo oooo oooo oooo oooo oooo oooo oooo oooo oooo", useCase: "Use it when: testing." },
    ];
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<TourOverlay open steps={steps} chapters={["One"]} ctx={{}} onClose={vi.fn()} />, { container: host });
    // Mount lands on m0 (missing) -> forward to OK; Back from OK walks into m0,
    // which is missing -> backward skip hits the front -> flips forward to OK.
    expect(await screen.findByText("OK")).toBeTruthy();
    fireEvent.click(screen.getByText("Back"));
    expect(await screen.findByText("OK")).toBeTruthy();
  });
});
