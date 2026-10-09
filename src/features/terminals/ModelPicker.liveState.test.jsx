// (C)
// @vitest-environment happy-dom
// The Models picker writes the keys back on every blur, and App's keychain
// mirror turns a key missing from that write into a DELETE once the launch
// load is over (secretVault diffOps: in the baseline, not in the save). The
// picker used to copy the keys when it opened and save that copy, so a key
// that reached App while it was open (the first keychain read finishing,
// App's launch merge, another window's save through App's storage handler)
// was left out of the next blur's save and deleted from the keychain.
//
// The harness holds user state the way App does: saveUser takes a value or an
// updater, and an updater sees the LIVE state (App's userStRef), which can be
// ahead of what the picker last rendered.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";

vi.mock("@backend", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

import ModelPicker from "./ModelPicker.jsx";
import { ToastProvider } from "../../components/Toast.jsx";

// App's user state, reduced to what the picker touches: a live ref that every
// saveUser updater reads (App's userStRef), and the rendered copy the picker
// gets as a prop. `arrive` is how state reaches App without the picker doing
// anything (App's launch merge and storage handler both do ref, then render);
// `arriveUnrendered` stops after the ref, the moment before React re-renders.
function renderPicker(initial) {
  const live = { current: initial };
  const saves = [];
  let setRendered;
  let setOpen;
  function Host() {
    const [userSt, setUserSt] = useState(initial);
    const [open, setOpenState] = useState(true);
    setRendered = setUserSt;
    setOpen = setOpenState;
    const saveUser = (next) => {
      const resolved = typeof next === "function" ? next(live.current) : next;
      saves.push(resolved);
      live.current = resolved;
      setUserSt(resolved);
    };
    return (
      <ToastProvider>
        <ModelPicker open={open} onClose={() => {}} userSt={userSt} saveUser={saveUser} />
      </ToastProvider>
    );
  }
  render(<Host />);
  return {
    live,
    saves,
    arrive(next) {
      act(() => {
        live.current = next;
        setRendered(next);
      });
    },
    arriveUnrendered(next) {
      live.current = next;
    },
    // Closes and reopens the dialog without unmounting it.
    reopen() {
      act(() => setOpen(false));
      act(() => setOpen(true));
    },
  };
}

const keyField = (label) => screen.getByLabelText(`${label} API key`);
// Opens a provider's row (one is open at a time) unless it already is.
const openRow = (label) => {
  if (!screen.queryByLabelText(`${label} API key`)) fireEvent.click(screen.getByText(label));
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Models saves only what the user changed in it, over the live state", () => {
  test("keys that reach App while Models is open are in the next save", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: { anthropic: "A-KEY" } });
    // App's launch merge lands while the dialog is open.
    h.arrive({ welcomeDone: true, providerKeys: { anthropic: "A-KEY", moonshot: "M-KEY", openai: "O-KEY" } });
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.providerKeys).toEqual({ anthropic: "A-KEY", moonshot: "M-KEY", openai: "O-KEY" });
  });

  test("a save made before React re-renders still carries the keys App holds", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: { anthropic: "A-KEY" } });
    // App has set its ref (userStRef) and asked React to render; the picker
    // still shows the old state when the user leaves the field.
    h.arriveUnrendered({ welcomeDone: true, providerKeys: { anthropic: "A-KEY", moonshot: "M-KEY" } });
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.providerKeys).toEqual({ anthropic: "A-KEY", moonshot: "M-KEY" });
  });

  test("an edit saved before React re-renders keeps the keys App holds", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: { anthropic: "A-KEY" } });
    fireEvent.change(keyField("Anthropic (Claude)"), { target: { value: "A-MINE" } });
    h.arriveUnrendered({ welcomeDone: true, providerKeys: { anthropic: "A-KEY", moonshot: "M-KEY" } });
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.providerKeys).toEqual({ anthropic: "A-MINE", moonshot: "M-KEY" });
  });

  test("the user's own edit and removal survive keys arriving, and only they change", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: { anthropic: "A-KEY", openai: "O-KEY" } });
    // One row is open at a time; neither field is left (no blur) until the end.
    openRow("OpenAI");
    fireEvent.change(keyField("OpenAI"), { target: { value: "" } }); // removed here
    openRow("Groq (fast inference)");
    fireEvent.change(keyField("Groq (fast inference)"), { target: { value: "G-NEW" } }); // typed here
    h.arrive({ welcomeDone: true, providerKeys: { anthropic: "A-ROTATED", openai: "O-KEY", moonshot: "M-KEY" } });
    // What the user typed is still on screen, and what arrived shows too.
    expect(keyField("Groq (fast inference)").value).toBe("G-NEW");
    openRow("OpenAI");
    expect(keyField("OpenAI").value).toBe("");
    openRow("Moonshot · Kimi K2");
    expect(keyField("Moonshot · Kimi K2").value).toBe("M-KEY");
    openRow("Anthropic (Claude)");
    expect(keyField("Anthropic (Claude)").value).toBe("A-ROTATED");
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.providerKeys).toEqual({ anthropic: "A-ROTATED", openai: "", moonshot: "M-KEY", groq: "G-NEW" });
  });

  test("a key that arrived counts when a model is picked", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: {} });
    h.arrive({ welcomeDone: true, providerKeys: { moonshot: "M-KEY" } });
    openRow("Moonshot · Kimi K2");
    fireEvent.click(screen.getByTitle(/^Use kimi-k2\.5/));
    expect(h.saves.at(-1)?.activeModel).toEqual({ providerId: "moonshot", model: "kimi-k2.5" });
    expect(h.saves.at(-1)?.providerKeys).toEqual({ moonshot: "M-KEY" });
    expect(screen.queryByText(/Enter the provider's API key first/)).toBeNull();
  });

  test("a saved edit gives way to a later change from elsewhere", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: { anthropic: "A-KEY" } });
    fireEvent.change(keyField("Anthropic (Claude)"), { target: { value: "A-MINE" } });
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.providerKeys.anthropic).toBe("A-MINE");
    // Another window rotates it afterwards; leaving some other field must not
    // put this dialog's earlier value back.
    h.arrive({ ...h.live.current, providerKeys: { anthropic: "A-OTHER" } });
    expect(keyField("Anthropic (Claude)").value).toBe("A-OTHER");
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.providerKeys.anthropic).toBe("A-OTHER");
  });

  test("leaving a field does not revert a model choice or an endpoint changed elsewhere", () => {
    const h = renderPicker({
      welcomeDone: true,
      providerKeys: { anthropic: "A-KEY", custom: "C-KEY" },
      providerBaseUrls: { custom: "https://one.example/v1" },
      activeModel: { providerId: "anthropic", model: "claude-opus-5-5" },
    });
    // The phone picks another model and another window moves the endpoint,
    // and the user leaves a field before the dialog has re-rendered.
    h.arriveUnrendered({
      ...h.live.current,
      providerBaseUrls: { custom: "https://two.example/v1" },
      activeModel: { providerId: "custom", model: "qwen2.5-coder:7b" },
    });
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.activeModel).toEqual({ providerId: "custom", model: "qwen2.5-coder:7b" });
    expect(h.saves.at(-1)?.providerBaseUrls).toEqual({ custom: "https://two.example/v1" });
  });

  test("a saved endpoint edit gives way to a later change from elsewhere", () => {
    const h = renderPicker({
      welcomeDone: true,
      providerKeys: { custom: "C-KEY" },
      providerBaseUrls: { custom: "https://one.example/v1" },
      activeModel: { providerId: "custom", model: "m" },
    });
    const endpoint = () => screen.getByLabelText("Custom (any OpenAI-compatible endpoint) endpoint base URL");
    fireEvent.change(endpoint(), { target: { value: "https://mine.example/v1" } });
    fireEvent.blur(endpoint());
    expect(h.saves.at(-1)?.providerBaseUrls).toEqual({ custom: "https://mine.example/v1" });
    h.arrive({ ...h.live.current, providerBaseUrls: { custom: "https://other.example/v1" } });
    expect(endpoint().value).toBe("https://other.example/v1");
    fireEvent.blur(keyField("Custom (any OpenAI-compatible endpoint)"));
    expect(h.saves.at(-1)?.providerBaseUrls).toEqual({ custom: "https://other.example/v1" });
  });

  test("typing that was never saved is gone when Models is closed and opened again", () => {
    const h = renderPicker({
      welcomeDone: true,
      providerKeys: { custom: "C-KEY" },
      providerBaseUrls: { custom: "https://one.example/v1" },
      activeModel: { providerId: "custom", model: "m" },
    });
    const endpoint = () => screen.getByLabelText("Custom (any OpenAI-compatible endpoint) endpoint base URL");
    fireEvent.change(keyField("Custom (any OpenAI-compatible endpoint)"), { target: { value: "C-HALF" } });
    fireEvent.change(endpoint(), { target: { value: "https://half.example/v1" } });
    h.reopen();
    expect(keyField("Custom (any OpenAI-compatible endpoint)").value).toBe("C-KEY");
    expect(endpoint().value).toBe("https://one.example/v1");
    fireEvent.blur(keyField("Custom (any OpenAI-compatible endpoint)"));
    expect(h.saves.at(-1)?.providerKeys).toEqual({ custom: "C-KEY" });
    expect(h.saves.at(-1)?.providerBaseUrls).toEqual({ custom: "https://one.example/v1" });
  });

  test("the rest of the user state is the live one, not the one the dialog last rendered", () => {
    const h = renderPicker({ welcomeDone: true, providerKeys: { anthropic: "A-KEY" }, themeFollowOS: false });
    h.arriveUnrendered({ welcomeDone: true, providerKeys: { anthropic: "A-KEY" }, themeFollowOS: true });
    fireEvent.blur(keyField("Anthropic (Claude)"));
    expect(h.saves.at(-1)?.themeFollowOS).toBe(true);
  });
});
