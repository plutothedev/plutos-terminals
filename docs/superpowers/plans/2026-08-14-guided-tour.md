<!-- (C) -->
# Guided Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chaptered spotlight tour of every app control (25 stops: what it does + use case), auto-offered once after onboarding, replayable from Help.

**Architecture:** In-house engine, zero deps. Pure data (`tourSteps.js`) + pure placement math (`placement.js`) + one overlay component (`TourOverlay.jsx`) + `data-tour` attributes on existing chrome. TerminalsTab owns open-state and passes a ctx of existing setters for step prep.

**Tech Stack:** React 18, vitest (+jsdom pragma for DOM tests), existing `--phn-*` token CSS in `terminals.css`.

**Spec:** `docs/superpowers/specs/2026-08-14-guided-tour-design.md` (step copy lives there; tasks below reference it as COPY[n]).

---

### Task 1: placement.js (pure math, TDD)

**Files:**
- Create: `src/features/terminals/tour/placement.js`
- Test: `src/features/terminals/tour/placement.test.js`

- [ ] **Step 1: Write the failing test**

```js
// (C)
import { describe, test, expect } from "vitest";
import { pickPlacement } from "./placement.js";

const VP = { w: 1200, h: 800 };
const CARD = { w: 340, h: 180 };
const M = 12; // margin

describe("pickPlacement", () => {
  test("prefers below the target when there is room", () => {
    const t = { left: 400, top: 100, width: 120, height: 30 };
    const p = pickPlacement(t, CARD, VP);
    expect(p.side).toBe("below");
    expect(p.y).toBe(100 + 30 + M);
    // horizontally centered on target, not clamped here
    expect(p.x).toBe(Math.round(400 + 120 / 2 - 340 / 2));
  });

  test("flips above when below would overflow the viewport", () => {
    const t = { left: 400, top: 700, width: 120, height: 60 };
    const p = pickPlacement(t, CARD, VP);
    expect(p.side).toBe("above");
    expect(p.y).toBe(700 - 180 - M);
  });

  test("falls to the side when neither above nor below fits", () => {
    const t = { left: 100, top: 90, width: 60, height: 620 }; // tall rail
    const p = pickPlacement(t, CARD, VP);
    expect(p.side).toBe("right");
    expect(p.x).toBe(100 + 60 + M);
  });

  test("clamps x into the viewport at corners", () => {
    const t = { left: 1150, top: 100, width: 40, height: 30 };
    const p = pickPlacement(t, CARD, VP);
    expect(p.x + CARD.w).toBeLessThanOrEqual(VP.w - M);
    expect(p.x).toBeGreaterThanOrEqual(M);
  });

  test("null target centers the card", () => {
    const p = pickPlacement(null, CARD, VP);
    expect(p.side).toBe("center");
    expect(p.x).toBe(Math.round((1200 - 340) / 2));
    expect(p.y).toBe(Math.round((800 - 180) / 2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/terminals/tour/placement.test.js`
Expected: FAIL — `Cannot find module './placement.js'`

- [ ] **Step 3: Write the implementation**

```js
// (C)
// Pure placement math for the tour card: pick a side with room, clamp into
// the viewport. No DOM access — testable in node.
const MARGIN = 12;

export function pickPlacement(targetRect, card, viewport) {
  const clampX = (x) =>
    Math.round(Math.min(Math.max(x, MARGIN), viewport.w - card.w - MARGIN));
  const clampY = (y) =>
    Math.round(Math.min(Math.max(y, MARGIN), viewport.h - card.h - MARGIN));

  if (!targetRect) {
    return {
      side: "center",
      x: Math.round((viewport.w - card.w) / 2),
      y: Math.round((viewport.h - card.h) / 2),
    };
  }

  const centeredX = clampX(targetRect.left + targetRect.width / 2 - card.w / 2);
  const below = targetRect.top + targetRect.height + MARGIN;
  if (below + card.h <= viewport.h - MARGIN) {
    return { side: "below", x: centeredX, y: Math.round(below) };
  }
  const above = targetRect.top - card.h - MARGIN;
  if (above >= MARGIN) {
    return { side: "above", x: centeredX, y: Math.round(above) };
  }
  const centeredY = clampY(targetRect.top + targetRect.height / 2 - card.h / 2);
  const right = targetRect.left + targetRect.width + MARGIN;
  if (right + card.w <= viewport.w - MARGIN) {
    return { side: "right", x: Math.round(right), y: centeredY };
  }
  const left = targetRect.left - card.w - MARGIN;
  if (left >= MARGIN) {
    return { side: "left", x: Math.round(left), y: centeredY };
  }
  return { side: "center", x: clampX((viewport.w - card.w) / 2), y: clampY((viewport.h - card.h) / 2) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/terminals/tour/placement.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/terminals/tour/placement.js src/features/terminals/tour/placement.test.js
git commit -m "feat(tour): placement math for the tour card"
```

---

### Task 2: tourSteps.js (data + all copy) + integrity test

**Files:**
- Create: `src/features/terminals/tour/tourSteps.js`
- Test: `src/features/terminals/tour/tourSteps.test.js`

- [ ] **Step 1: Write the failing integrity test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/terminals/tour/tourSteps.test.js`
Expected: FAIL — `Cannot find module './tourSteps.js'`

- [ ] **Step 3: Write the data**

Copy comes verbatim from the spec (COPY[1..25], `docs/superpowers/specs/2026-08-14-guided-tour-design.md` "Chapters and step copy"). Structure:

```js
// (C)
// Tour data. body = what it is / what it does. useCase = "Use it when: ...".
// target = [data-tour=...] selector or null for a centered card.
// prep(ctx) puts the UI in the right state BEFORE the target is measured;
// ctx = { setDockTab, collapseDock } (from TerminalsTab).
export const TOUR_CHAPTERS = [
  "Welcome", "Connect", "Workspace", "AI tools", "Tools dock", "Speed", "Finish",
];

export const TOUR_STEPS = [
  { id: "welcome", chapter: "Welcome", target: null,
    title: "Welcome to Pluto's Terminal",
    body: "One window for every shell, server, and AI agent you work with. Left: your saved sessions. Middle: tabs and terminals. Right: file transfer, AI assistant, and system monitor. This tour walks every control: about 2 minutes. Arrow keys move, Esc leaves.",
  },
  { id: "connect-local", chapter: "Connect", target: '[data-tour="local"]',
    title: "Local shell",
    body: "Opens a local shell tab in your default shell: PowerShell, cmd, bash, zsh. Change the default in Settings.",
    useCase: "Use it when: you just need a terminal, fast." },
  // ... every remaining step in spec order, same shape; dock steps add prep:
  { id: "dock-sftp", chapter: "Tools dock", target: '[data-tour="dock-files"]',
    title: "SFTP file browser",
    body: "A file browser for the active SSH session. Upload, download, rename, delete; double-click a remote file to edit locally and it writes back on save. F4 toggles it.",
    useCase: "Use it when: config edits and file moves without ever typing scp.",
    prep: (ctx) => { ctx.collapseDock(false); ctx.setDockTab("files"); } },
  // dock-assistant → setDockTab("assistant"), dock-monitor → setDockTab("monitor"),
  // dock-collapse → target '[data-tour="dock-collapse"]'
  // final step:
  { id: "finish", chapter: "Finish", target: null,
    title: "That's the whole surface",
    body: "Three things worth doing now: save your first SSH session, pick an AI model (Ctrl+M), and join the Discord for packs, tips, and help. Replay this tour any time: Help > Take the tour.",
  },
];
```

Full step list (ids in order): welcome; connect-local, connect-ssh, connect-serial, sessions-tree; tab-strip, split, broadcast, tunnel, terminal-menu; ask-ai, agent-mode, models, workflows, fleet; dock-sftp, dock-assistant, dock-monitor, dock-collapse; quick-connect, palette, fkey-bar, status-bar, theme-toggle; finish. Targets map to Task 3's stamps: `local, ssh, serial, sessions-tree, tab-strip, split, multiexec, tunnel, menu-terminal, ask, agent, models, snips, agents, dock-files, dock-assistant, dock-monitor, dock-collapse, quick-connect, fkey-bar, status-bar, theme-toggle` (palette step targets `[data-tour="fkey-bar"]`'s palette chip: use `[data-tour="fkey-palette"]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/terminals/tour/tourSteps.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/terminals/tour/tourSteps.js src/features/terminals/tour/tourSteps.test.js
git commit -m "feat(tour): chaptered step data, full copy from the design spec"
```

---

### Task 3: data-tour stamps on chrome

**Files (all Modify):**
- `src/features/terminals/MobaToolbar.jsx:56` — the toolbar `<button>`: add `data-tour={it.id}`.
- `src/features/terminals/MobaMenuBar.jsx` — top-level menu button: add `` data-tour={`menu-${(m.label || "").toLowerCase()}`} `` (read the file first; the menus array items have `.label`).
- `src/features/terminals/chrome/DockTabStrip.jsx` — dock tab `<span>`: add `` data-tour={`dock-${t.id}`} ``; collapse `<button>`: add `data-tour="dock-collapse"`.
- `src/features/terminals/chrome/FKeyBar.jsx` — root `<div className="phn-fnbar">`: add `data-tour="fkey-bar"`; the Palette chip (the `modCombo("K")` item's rendered element): add `data-tour="fkey-palette"` (pass through however chips render — read the map's JSX below line 30).
- `src/features/terminals/chrome/StatusBar.jsx` — root element: add `data-tour="status-bar"`.
- `src/features/terminals/chrome/MenuBar.jsx:176` — theme toggle button: add `data-tour="theme-toggle"`.
- `src/features/terminals/TerminalPanel.jsx:476` — `.moba-tabstrip` div: add `data-tour="tab-strip"`.
- `src/features/terminals/chrome/Toolbar.jsx` — quick-connect wrapper `.moba-qc-inline`: add `data-tour="quick-connect"`.
- `src/features/terminals/TerminalsTab.jsx` (~line 960-980) — the sessions sidebar container (the element wrapping `<ProjectSidebar>`; read the JSX first): add `data-tour="sessions-tree"`.

- [ ] **Step 1: Apply every stamp above** (mechanical one-attribute edits; read each site first, keep formatting)
- [ ] **Step 2: Verify no render breakage**

Run: `npx vitest run`
Expected: PASS (attribute-only changes)

- [ ] **Step 3: Commit**

```bash
git add -A src/
git commit -m "feat(tour): data-tour anchors across the chrome"
```

---

### Task 4: TourOverlay engine (TDD on behavior)

**Files:**
- Create: `src/features/terminals/tour/TourOverlay.jsx`
- Test: `src/features/terminals/tour/TourOverlay.test.jsx`
- Modify: `src/features/terminals/terminals.css` (append tour styles)

- [ ] **Step 1: Write the failing behavior test**

```jsx
// (C)
// @vitest-environment jsdom
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import TourOverlay from "./TourOverlay.jsx";

const STEPS = [
  { id: "a", chapter: "One", target: null, title: "A", body: "aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa" },
  { id: "b", chapter: "One", target: '[data-tour="exists"]', title: "B", body: "bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb", useCase: "Use it when: testing." },
  { id: "c", chapter: "Two", target: '[data-tour="missing"]', title: "C", body: "cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc", useCase: "Use it when: never." },
  { id: "d", chapter: "Two", target: null, title: "D", body: "dddd dddd dddd dddd dddd dddd dddd dddd dddd dddd" },
];

beforeEach(() => {
  document.body.innerHTML = '<div data-tour="exists">x</div>';
});

function mount(onClose = vi.fn()) {
  render(<TourOverlay open steps={STEPS} ctx={{}} onClose={onClose} />, { container: document.body.appendChild(document.createElement("div")) });
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
    fireEvent.click(screen.getByText("Next"));          // a → b (exists)
    expect(await screen.findByText("B")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));          // b → c missing → d
    expect(await screen.findByText("D")).toBeTruthy();
  });

  test("Escape ends the tour via onClose", () => {
    const onClose = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("chapter jump goes to the first step of that chapter (skipping missing targets)", async () => {
    mount();
    fireEvent.click(screen.getByText("Chapters"));
    fireEvent.click(screen.getByText("Two"));           // first of Two = c, missing → d
    expect(await screen.findByText("D")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/terminals/tour/TourOverlay.test.jsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the engine**

```jsx
// (C)
// Spotlight tour engine. Zero deps: dim backdrop = 4 rects around the target,
// glow ring, token-styled card via placement.js. Steps are data (tourSteps).
// Missing targets auto-skip in the direction of travel; prep(ctx) runs before
// measuring so steps can open the dock etc. Esc / Skip end the tour.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pickPlacement } from "./placement.js";
import { TOUR_STEPS, TOUR_CHAPTERS } from "./tourSteps.js";

const CARD = { w: 340, h: 190 };

export default function TourOverlay({ open, onClose, ctx, steps = TOUR_STEPS, chapters = TOUR_CHAPTERS }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);        // null = centered card
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const dirRef = useRef(1);
  const step = steps[i];

  const goto = useCallback((idx, dir) => {
    dirRef.current = dir;
    if (idx < 0) idx = 0;
    if (idx >= steps.length) { onClose(true); return; }
    setChaptersOpen(false);
    setI(idx);
  }, [steps.length, onClose]);

  // Measure the current step's target; skip (in travel direction) if absent.
  useLayoutEffect(() => {
    if (!open || !step) return;
    let raf = 0;
    try { step.prep?.(ctx); } catch { /* prep is best-effort */ }
    raf = requestAnimationFrame(() => {
      if (step.target === null) { setRect(null); return; }
      const el = document.querySelector(step.target);
      if (!el) { goto(i + dirRef.current, dirRef.current); return; }
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      setRect(el.getBoundingClientRect());
    });
    return () => cancelAnimationFrame(raf);
  }, [open, i, step, ctx, goto]);

  // Re-measure on resize.
  useEffect(() => {
    if (!open) return;
    const re = () => {
      if (!step || step.target === null) return;
      const el = document.querySelector(step.target);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", re);
    return () => window.removeEventListener("resize", re);
  }, [open, step]);

  // Keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); goto(i + 1, 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goto(i - 1, -1); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, i, goto, onClose]);

  if (!open || !step) return null;

  const vp = { w: window.innerWidth, h: window.innerHeight };
  const p = pickPlacement(rect, CARD, vp);
  const chapterOf = (idx) => steps[idx]?.chapter;

  return (
    <div className="phn-tour" role="presentation">
      {rect ? (
        <>
          <div className="phn-tour-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - 4) }} />
          <div className="phn-tour-dim" style={{ top: rect.bottom + 4, left: 0, right: 0, bottom: 0 }} />
          <div className="phn-tour-dim" style={{ top: Math.max(0, rect.top - 4), left: 0, width: Math.max(0, rect.left - 4), height: rect.height + 8 }} />
          <div className="phn-tour-dim" style={{ top: Math.max(0, rect.top - 4), left: rect.right + 4, right: 0, height: rect.height + 8 }} />
          <div className="phn-tour-ring" style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }} />
        </>
      ) : (
        <div className="phn-tour-dim" style={{ inset: 0 }} />
      )}
      <div
        className="phn-tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Tour step ${i + 1} of ${steps.length}: ${step.title}`}
        style={{ left: p.x, top: p.y, width: CARD.w }}
      >
        <div className="phn-tour-chapter">{step.chapter}</div>
        <div className="phn-tour-title">{step.title}</div>
        <div className="phn-tour-body" aria-live="polite">
          {step.body}
          {step.useCase ? <div className="phn-tour-usecase">{step.useCase}</div> : null}
        </div>
        <div className="phn-tour-foot">
          <button className="phn-tour-link" onClick={() => setChaptersOpen((v) => !v)}>Chapters</button>
          <span className="phn-tour-progress">{i + 1}/{steps.length}</span>
          <span className="phn-tour-btns">
            <button className="phn-tour-btn" disabled={i === 0} onClick={() => goto(i - 1, -1)}>Back</button>
            <button className="phn-tour-btn primary" onClick={() => goto(i + 1, 1)}>{i === steps.length - 1 ? "Finish" : "Next"}</button>
            <button className="phn-tour-btn quiet" onClick={() => onClose(false)}>Skip</button>
          </span>
        </div>
        {chaptersOpen && (
          <div className="phn-tour-chlist">
            {chapters.map((c) => {
              const first = steps.findIndex((s) => s.chapter === c);
              if (first < 0) return null;
              return (
                <button key={c} className={c === chapterOf(i) ? "phn-tour-chitem active" : "phn-tour-chitem"} onClick={() => goto(first, 1)}>
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

CSS appended to `terminals.css` (token-themed; exact block in the task commit):

```css
/* ── Guided tour (spotlight + card) ─────────────────────────────────── */
.phn-tour { position: fixed; inset: 0; z-index: 100000; font-family: var(--phn-ui-font); }
.phn-tour-dim { position: absolute; background: rgba(0, 0, 0, 0.55); }
.phn-tour-ring { position: absolute; border: 2px solid var(--phn-link, #7c9cf5); border-radius: 6px;
  box-shadow: 0 0 0 4px rgba(124, 156, 245, 0.25), 0 0 22px rgba(124, 156, 245, 0.35); pointer-events: none; }
.phn-tour-card { position: absolute; background: var(--phn-elevated-bg, #1b1c1f);
  border: 1px solid var(--phn-surface-border, rgba(255,255,255,0.07)); border-radius: 8px;
  padding: 12px 14px; color: var(--phn-text-fg, #d6d8dc); box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
.phn-tour-chapter { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--phn-link, #7c9cf5); margin-bottom: 3px; }
.phn-tour-title { font-size: 14px; font-weight: 700; color: var(--phn-text-active, #eceef0); margin-bottom: 6px; }
.phn-tour-body { font-size: 12px; line-height: 1.5; }
.phn-tour-usecase { margin-top: 6px; color: var(--phn-text-dim, #9a9da3); font-style: italic; }
.phn-tour-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.phn-tour-progress { color: var(--phn-text-faint, #67696e); font-size: 11px; margin-left: auto; }
.phn-tour-btn { background: var(--phn-surface-bg, #101113); border: 1px solid var(--phn-surface-border, rgba(255,255,255,0.07));
  color: var(--phn-text-fg, #d6d8dc); border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.phn-tour-btn.primary { background: var(--phn-link, #7c9cf5); border-color: transparent; color: var(--phn-accent-fg, #0e1018); font-weight: 600; }
.phn-tour-btn.quiet { background: transparent; border-color: transparent; color: var(--phn-text-faint, #67696e); }
.phn-tour-btn:disabled { opacity: 0.4; cursor: default; }
.phn-tour-btns { display: inline-flex; gap: 6px; }
.phn-tour-link { background: none; border: none; color: var(--phn-link, #7c9cf5); font-size: 11px; cursor: pointer; padding: 0; }
.phn-tour-chlist { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; border-top: 1px solid var(--phn-surface-border, rgba(255,255,255,0.07)); padding-top: 8px; }
.phn-tour-chitem { background: var(--phn-surface-bg, #101113); border: 1px solid var(--phn-surface-border, rgba(255,255,255,0.07));
  color: var(--phn-text-dim, #9a9da3); border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer; }
.phn-tour-chitem.active { color: var(--phn-accent-fg, #0e1018); background: var(--phn-link, #7c9cf5); border-color: transparent; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/terminals/tour/TourOverlay.test.jsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/terminals/tour/TourOverlay.jsx src/features/terminals/tour/TourOverlay.test.jsx src/features/terminals/terminals.css
git commit -m "feat(tour): spotlight overlay engine — backdrop, ring, card, chapters, keyboard"
```

---

### Task 5: first-run offer + wiring (TerminalsTab, MenuBar Help, persistence)

**Files:**
- Create: `src/features/terminals/tour/TourOffer.jsx`
- Modify: `src/features/terminals/TerminalsTab.jsx` (state + mounts + ctx)
- Modify: `src/features/terminals/chrome/MenuBar.jsx:138-143` (Help menu item)
- Test: extend `src/features/terminals/tour/TourOverlay.test.jsx` with a persistence test if wiring adds logic beyond glue (localStorage key writes live in TerminalsTab handlers; keep them one-line so glue stays untested)

- [ ] **Step 1: TourOffer component**

```jsx
// (C)
// One-time corner card offering the tour after onboarding. Either button
// writes phn.tourDone (the offer never returns); Start opens the tour.
export default function TourOffer({ onStart, onDismiss }) {
  return (
    <div className="phn-tour-offer" role="dialog" aria-label="Take the tour?">
      <div className="phn-tour-offer-title">New here?</div>
      <div className="phn-tour-offer-body">Take the 2-minute tour of everything.</div>
      <div className="phn-tour-offer-btns">
        <button className="phn-tour-btn primary" onClick={onStart}>Start tour</button>
        <button className="phn-tour-btn quiet" onClick={onDismiss}>No thanks</button>
      </div>
    </div>
  );
}
```

CSS (append to the tour block in `terminals.css`):

```css
.phn-tour-offer { position: fixed; right: 18px; bottom: 46px; z-index: 9000;
  background: var(--phn-elevated-bg, #1b1c1f); border: 1px solid var(--phn-surface-border, rgba(255,255,255,0.07));
  border-radius: 8px; padding: 12px 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); font-family: var(--phn-ui-font); }
.phn-tour-offer-title { font-weight: 700; font-size: 13px; color: var(--phn-text-active, #eceef0); }
.phn-tour-offer-body { font-size: 12px; color: var(--phn-text-fg, #d6d8dc); margin: 4px 0 10px; }
.phn-tour-offer-btns { display: flex; gap: 8px; }
```

- [ ] **Step 2: TerminalsTab wiring**

Near the other modal state (~line 100-130):

```jsx
const [tourOpen, setTourOpen] = useState(false);
const [tourOffered, setTourOffered] = useState(() => {
  try { return localStorage.getItem("phn.tourDone") === "1"; } catch { return true; }
});
const finishTour = useCallback(() => {
  setTourOpen(false);
  setTourOffered(true);
  try { localStorage.setItem("phn.tourDone", "1"); } catch {}
}, []);
const startTour = useCallback(() => { setTourOffered(true); try { localStorage.setItem("phn.tourDone", "1"); } catch {} setTourOpen(true); }, []);
```

Render (next to ModalHost, ~line 1106):

```jsx
{!tourOffered && <TourOffer onStart={startTour} onDismiss={finishTour} />}
<TourOverlay open={tourOpen} onClose={finishTour} ctx={{ setDockTab, collapseDock }} />
```

Read the file first for exact anchors and the `collapseDock` name in scope. Onboarding gate: TerminalsTab only renders after onboarding in App (VERIFY by reading how App mounts TerminalsTab / OnboardingOverlay; if TerminalsTab renders alongside the overlay, gate the offer with the same onboarded flag, threading it as a prop from App).

- [ ] **Step 3: Help menu item**

`MenuBar.jsx` Help menu (line ~138): add above "Pluto Discord":

```js
{ label: "Take the tour", action: onStartTour },
```

Thread `onStartTour` prop: MenuBar signature + TerminalsTab call site (`<MenuBar` at line ~892) passing `onStartTour={startTour}`.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(tour): first-run offer, Help-menu replay, TerminalsTab wiring"
```

---

### Task 6: visual verification (dev-pane loop) + polish

- [ ] **Step 1:** Dev server at `localhost:5310`; open the browser pane; run `localStorage.removeItem("phn.tourDone")` in the console; reload. Offer card appears bottom-right.
- [ ] **Step 2:** Start the tour. Walk all 25 stops with →. Verify: ring lands on the right control per stop; dock stops actually switch the dock tab; missing-target stops (no active SSH session → tunnel still targets the toolbar button, fine) don't wedge; card never overflows the viewport; Esc ends.
- [ ] **Step 3:** Repeat on `moba-light` and `oled` skins (set `data-phn-skin` on `div.phn-page` in console). Card + ring must read on both.
- [ ] **Step 4:** Fix what the eyes find (placement fudges, copy overflow, z-index collisions with modals). Re-run `npx vitest run`.
- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "fix(tour): visual pass across skins"
```

---

### Task 7: review + ship

- [ ] **Step 1:** Full suite: `npx vitest run` → PASS; `cargo test` untouched (no Rust changes).
- [ ] **Step 2:** code-reviewer agent over the tour diff; fix findings; re-review every fix (pluto rule).
- [ ] **Step 3:** Build + install ceremony (fixed script) so pluto can run the tour in the packaged app.
- [ ] **Step 4:** Update vault iteration-log entry.

## Self-review

- Spec coverage: engine ✓ (T4), steps+copy ✓ (T2), anchors ✓ (T3), offer+Help+persistence ✓ (T5), placement ✓ (T1), testing ✓ (T1/T2/T4), skins ✓ (T6). Out-of-scope items absent ✓.
- Placeholders: T2 elides 20 of 25 step objects with "same shape" pointing at spec COPY — the copy exists verbatim in the committed spec, so the executor has the actual content; ids and target map enumerated. Acceptable by reference.
- Type consistency: `pickPlacement(rect, CARD, vp)` matches T1 signature; `ctx = { setDockTab, collapseDock }` matches T2 prep usage and T5 wiring; `steps`/`chapters` props default to real data, tests inject fixtures ✓.
