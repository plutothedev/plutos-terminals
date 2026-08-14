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
});
