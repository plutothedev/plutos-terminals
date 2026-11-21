// @vitest-environment happy-dom
// (C)
// usePromptSlashMenu: the stored index is re-clamped when the filtered list
// shrinks under an open menu (a drawer delete or a sync merge, no keystroke),
// so a later regrow cannot resurrect a stale position, and Enter always picks
// the highlighted item. Pinned before the re-clamp moved from an effect to a
// render-time adjustment (v0.7.6 lint cleanup).
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePromptSlashMenu } from "./usePromptSlashMenu.js";

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `p${i}`, body: `body ${i}` }));
const down = () => ({ key: "ArrowDown", preventDefault() {} });
const enter = () => ({ key: "Enter", preventDefault() {} });

function setup(prompts, value = "/") {
  let set = null;
  const setValue = (v) => { set = v; };
  const hook = renderHook(({ prompts, value }) => usePromptSlashMenu({ value, setValue, prompts }), {
    initialProps: { prompts, value },
  });
  return { ...hook, lastSet: () => set };
}

describe("usePromptSlashMenu index re-clamp", () => {
  it("re-clamps the stored index when the list shrinks, so a regrow does not resurrect it", () => {
    const five = mk(5);
    const { result, rerender } = setup(five);
    act(() => { result.current.onKeyDown(down()); });
    act(() => { result.current.onKeyDown(down()); });
    act(() => { result.current.onKeyDown(down()); });
    expect(result.current.selectedIndex).toBe(3);

    // List shrinks to 2 while the menu is open: highlight clamps to the last item.
    rerender({ prompts: five.slice(0, 2), value: "/" });
    expect(result.current.selectedIndex).toBe(1);

    // List grows back: the stored index was re-clamped, so it stays at 1
    // instead of jumping back to the stale 3.
    rerender({ prompts: five, value: "/" });
    expect(result.current.selectedIndex).toBe(1);
  });

  it("Enter inserts exactly the highlighted item after a shrink", () => {
    const five = mk(5);
    const { result, rerender, lastSet } = setup(five);
    for (let i = 0; i < 4; i += 1) act(() => { result.current.onKeyDown(down()); });
    expect(result.current.selectedIndex).toBe(4);
    rerender({ prompts: five.slice(0, 3), value: "/" });
    expect(result.current.selectedIndex).toBe(2);
    act(() => { result.current.onKeyDown(enter()); });
    expect(lastSet()).toBe("body 2");
  });

  it("an empty list leaves the index at 0 and Enter passes through", () => {
    const { result } = setup([], "/");
    expect(result.current.open).toBe(false);
    expect(result.current.selectedIndex).toBe(0);
    expect(result.current.onKeyDown(enter())).toBe("passthrough");
  });

  it("select keeps its identity across a re-render with unchanged inputs", () => {
    const five = mk(5);
    const { result, rerender } = setup(five);
    const select1 = result.current.select;
    rerender({ prompts: five, value: "/" });
    expect(result.current.select).toBe(select1);
  });
});
