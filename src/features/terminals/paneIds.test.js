// (C)
import { describe, it, expect } from "vitest";
import { allRenderedPaneIds } from "./paneIds.js";
import { getLayout, leafIds } from "./splitTree.js";

// Fixture cases (per the B1 plan, Task 2 Step 2):
//   (a) a single-pane tab (no `layout` — implicit root leaf, id === tab.id)
//   (b) a split tab with a layout tree (multiple leaves)
//   (c) multiple panels
//   (d) a panel with a non-active (hidden) tab — TerminalPanel keeps every
//       tab mounted (only the wrapper div's CSS display toggles), so a
//       backgrounded tab's ids must still come back as "live".
describe("allRenderedPaneIds", () => {
  it("mirrors TerminalPanel's per-tab leaf-id derivation across panels/splits/hidden tabs (a+b+c+d)", () => {
    const panels = [
      {
        id: "panel1",
        activeTabId: "tabA", // tabA is the visible tab; tabB is hidden — case (d)
        tabs: [
          { id: "tabA" }, // (a) single-pane tab
          {
            id: "tabB", // (b) split tab with a stored layout
            layout: {
              id: "split-1",
              dir: "row",
              ratio: 0.5,
              a: { id: "tabB-leaf-1" },
              b: { id: "tabB-leaf-2" },
            },
          },
        ],
      },
      {
        id: "panel2", // (c) a second panel
        activeTabId: "tabC",
        tabs: [{ id: "tabC" }],
      },
    ];

    // Hand-derived expectation copied straight from TerminalPanel's own logic
    // (NOT via allRenderedPaneIds): for every tab in every panel,
    // leafIds(getLayout(tab)) — independent of tabVisible/activeTabId, since
    // TerminalPanel maps every tab regardless of which one is active.
    const expected = [];
    for (const panel of panels) {
      for (const tab of panel.tabs) {
        expected.push(...leafIds(getLayout(tab)));
      }
    }
    expect(expected).toEqual(["tabA", "tabB-leaf-1", "tabB-leaf-2", "tabC"]);
    expect(allRenderedPaneIds(panels)).toEqual(expected);
  });

  it("case (d) isolated: a non-active (hidden) tab's ids are STILL counted live", () => {
    const panels = [
      {
        id: "panel1",
        activeTabId: "visible-tab",
        tabs: [
          { id: "visible-tab" },
          { id: "hidden-tab" }, // not activeTabId; TerminalPanel still renders its TerminalPane(s) (display:none)
        ],
      },
    ];
    // An "optimization" to active-only would make the sweep kill every
    // background tab's session — this must not happen.
    expect(allRenderedPaneIds(panels)).toEqual(["visible-tab", "hidden-tab"]);
  });

  it("excludes home/vnc/rdp tabs — TerminalPanel renders MobaHomeScreen/VncView/RdpView instead of TerminalPane for these, so no registry entry is ever created under their id", () => {
    const panels = [
      {
        id: "panel1",
        activeTabId: "home-tab",
        tabs: [
          { id: "home-tab", home: true },
          { id: "vnc-tab", vnc: { host: "1.2.3.4", port: 5900 } },
          { id: "rdp-tab", rdp: { host: "1.2.3.4", port: 3389 } },
          { id: "real-tab" },
        ],
      },
    ];
    expect(allRenderedPaneIds(panels)).toEqual(["real-tab"]);
  });

  it("returns [] for no panels / panels with no tabs", () => {
    expect(allRenderedPaneIds([])).toEqual([]);
    expect(allRenderedPaneIds([{ id: "p1", tabs: [] }])).toEqual([]);
    expect(allRenderedPaneIds(undefined)).toEqual([]);
  });
});
