// (C)
// @vitest-environment happy-dom
// The Models picker shows each provider's own model list once its key is set.
// Before this, it only knew the ids typed into providers.js, so a model
// released after the build (Claude Opus 5.5) could not be picked from a chip.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@backend", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import ModelPicker from "./ModelPicker.jsx";
import { ToastProvider } from "../../components/Toast.jsx";
import { MODEL_CACHE_KEY } from "./modelCatalog.js";

const DAY = 24 * 60 * 60 * 1000;
const secsAgo = (ms) => Math.floor((Date.now() - ms) / 1000);

const ANTHROPIC_LIST = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", created: secsAgo(200 * DAY) },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", created: secsAgo(5 * DAY) },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", created: secsAgo(360 * DAY) },
];

// User state held the way App holds it: saveUser takes a value or an updater
// (Models saves through an updater over the live state), and the picker is
// re-rendered with what was saved. `saveUser.saved` lists each saved state.
function renderPicker(userSt) {
  const live = { current: userSt };
  const saveUser = vi.fn();
  saveUser.saved = [];
  function Host() {
    const [state, setState] = useState(userSt);
    saveUser.mockImplementation((next) => {
      const resolved = typeof next === "function" ? next(live.current) : next;
      live.current = resolved;
      saveUser.saved.push(resolved);
      setState(resolved);
    });
    return (
      <ToastProvider>
        <ModelPicker open onClose={() => {}} userSt={state} saveUser={saveUser} />
      </ToastProvider>
    );
  }
  render(<Host />);
  return saveUser;
}

const chipIds = () =>
  screen.getAllByTitle(/^Use /).map((el) => el.firstChild.textContent);

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
});
afterEach(cleanup);

describe("ModelPicker live lists", () => {
  test("with a key, the row loads the provider's own list, newest first, new ones labelled", async () => {
    invokeMock.mockResolvedValue(ANTHROPIC_LIST);
    renderPicker({ providerKeys: { anthropic: "sk-ant-test" } });

    await waitFor(() => expect(screen.getByText(/3 models from the provider/)).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("llm_list_models", { kind: "anthropic", baseUrl: "", apiKey: "sk-ant-test" });
    expect(chipIds()).toEqual(["claude-opus-5-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"]);
    const opus55 = screen.getByTitle(/^Use Claude Opus 5\.5/);
    expect(within(opus55).getByText("new")).toBeTruthy();
    expect(within(screen.getByTitle(/^Use Claude Opus 4\.8/)).queryByText("new")).toBeNull();
  });

  test("without a key, the built-in list shows and nothing is fetched", async () => {
    renderPicker({});
    expect(screen.getByText(/Built-in list\. Enter your key/)).toBeTruthy();
    expect(chipIds()).toContain("claude-opus-5-5"); // the built-in list is current too
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("a failed fetch keeps the built-in list, says why, and Retry asks again", async () => {
    invokeMock.mockRejectedValueOnce("invalid x-api-key").mockResolvedValueOnce(ANTHROPIC_LIST);
    renderPicker({ providerKeys: { anthropic: "sk-bad" } });

    await waitFor(() => expect(screen.getByText(/Couldn't load this provider's models \(invalid x-api-key\)/)).toBeTruthy());
    expect(chipIds()).toContain("claude-sonnet-5-5"); // built-in fallback
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText(/3 models from the provider/)).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  test("a fresh cached list shows without asking again", () => {
    localStorage.setItem(
      MODEL_CACHE_KEY,
      JSON.stringify({ anthropic: { base: "", fetchedAt: Date.now() - 60 * 1000, models: ANTHROPIC_LIST } }),
    );
    renderPicker({ providerKeys: { anthropic: "sk" } });
    expect(screen.getByText(/3 models from the provider · updated 1 min ago/)).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("picking a live chip makes that model active", async () => {
    invokeMock.mockResolvedValue(ANTHROPIC_LIST);
    const saveUser = renderPicker({ providerKeys: { anthropic: "sk" } });
    await waitFor(() => expect(screen.getByTitle(/^Use Claude Opus 5\.5/)).toBeTruthy());
    fireEvent.click(screen.getByTitle(/^Use Claude Opus 5\.5/));
    expect(saveUser.saved.at(-1)).toEqual(
      expect.objectContaining({ activeModel: { providerId: "anthropic", model: "claude-opus-5-5" } }),
    );
  });

  test("a long list gets a filter that narrows the chips", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `vendor/model-${i}`, created: 1700000000 + i }));
    many.push({ id: "anthropic/claude-opus-5.5", created: 1800000000 });
    invokeMock.mockResolvedValue(many);
    renderPicker({ providerKeys: { openrouter: "sk-or" }, activeModel: { providerId: "openrouter", model: "x" } });

    const filter = await screen.findByPlaceholderText("Filter 41 models");
    expect(chipIds()[0]).toBe("anthropic/claude-opus-5.5");
    fireEvent.change(filter, { target: { value: "opus" } });
    expect(chipIds()).toEqual(["anthropic/claude-opus-5.5"]);
    fireEvent.change(filter, { target: { value: "nothing-like-this" } });
    expect(screen.getByText(/No model matches/)).toBeTruthy();
  });

  test("a newly entered key loads that key's list when the field is left", async () => {
    invokeMock.mockResolvedValue(ANTHROPIC_LIST);
    renderPicker({});
    const key = screen.getByLabelText("Anthropic (Claude) API key");
    fireEvent.change(key, { target: { value: "sk-new" } });
    expect(invokeMock).not.toHaveBeenCalled(); // never while typing
    fireEvent.blur(key);
    await waitFor(() => expect(screen.getByText(/3 models from the provider/)).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("llm_list_models", { kind: "anthropic", baseUrl: "", apiKey: "sk-new" });
  });

  test("a date no JavaScript Date can hold, already in the cache, renders instead of crashing", () => {
    // What an endpoint reporting nanoseconds produced before llm.rs range-checked
    // dates: formatting it threw during render and took the app down.
    localStorage.setItem(
      MODEL_CACHE_KEY,
      JSON.stringify({
        anthropic: {
          base: "",
          fetchedAt: Date.now(),
          models: [{ id: "poisoned", name: "Poisoned", created: 1727000000000000 }, ...ANTHROPIC_LIST],
        },
      }),
    );
    renderPicker({ providerKeys: { anthropic: "sk" } });
    expect(screen.getByTitle("Use Poisoned")).toBeTruthy(); // no date, no "new", no throw
    expect(chipIds()).toContain("claude-opus-5-5");
  });

  test("a filter the user can no longer see stops filtering", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `vendor/model-${i}`, created: 1700000000 + i }));
    invokeMock.mockResolvedValue(many);
    renderPicker({ providerKeys: { openrouter: "sk-or" }, activeModel: { providerId: "openrouter", model: "x" } });
    const filter = await screen.findByPlaceholderText("Filter 40 models");
    fireEvent.change(filter, { target: { value: "claude" } });
    // Clearing the key brings back the 14-model built-in list: no filter box.
    const key = screen.getByLabelText("OpenRouter (300+ models) API key");
    fireEvent.change(key, { target: { value: "" } });
    expect(screen.queryByPlaceholderText(/^Filter /)).toBeNull();
    expect(chipIds()).toHaveLength(14);
  });

  test("an address without a list says so instead of showing a raw error", async () => {
    invokeMock.mockRejectedValue("HTTP 404: url.not_found");
    renderPicker({ providerKeys: { moonshot: "sk-moon" }, activeModel: { providerId: "moonshot", model: "kimi-k2.5" } });
    await waitFor(() => expect(screen.getByText(/This address doesn't publish a model list \(HTTP 404\)/)).toBeTruthy());
    expect(chipIds()).toContain("kimi-k2.5");
  });

  test("leaving the key field unchanged does not refetch", async () => {
    localStorage.setItem(
      MODEL_CACHE_KEY,
      JSON.stringify({ anthropic: { base: "", fetchedAt: Date.now(), models: ANTHROPIC_LIST } }),
    );
    renderPicker({ providerKeys: { anthropic: "sk" } });
    fireEvent.blur(screen.getByLabelText("Anthropic (Claude) API key"));
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
