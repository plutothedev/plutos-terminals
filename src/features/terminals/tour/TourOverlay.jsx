// (C)
// Spotlight tour engine. Zero deps: dim backdrop = 4 rects around the target,
// glow ring, token-styled card placed by placement.js. Steps are data
// (tourSteps.js); missing targets auto-skip in the direction of travel;
// prep(ctx) runs before measuring so a step can open the dock first.
// Esc / Skip end the tour (onClose(false)); finishing the last step calls
// onClose(true). The caller owns persistence.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusablesIn } from "../../../components/Modal.jsx";
import { pickPlacement } from "./placement.js";
import { TOUR_STEPS, TOUR_CHAPTERS } from "./tourSteps.js";

const CARD = { w: 340, h: 190 };
const PAD = 4; // gap between the target and the ring/dim cutout

export default function TourOverlay({ open, onClose, ctx, steps = TOUR_STEPS, chapters = TOUR_CHAPTERS }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null); // null = centered card
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const dirRef = useRef(1);
  const closedRef = useRef(false); // onClose fires exactly once per open (key-repeat / double-click guard)
  const cardRef = useRef(null);
  const step = steps[i];

  const close = useCallback((completed) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(completed);
  }, [onClose]);

  // remeasure bumps when goto lands on the CURRENT index (front-clamp case):
  // setI(same) bails out of a render, so the measurement effect keys on this
  // nonce too — otherwise a missing-target step 0 would freeze the tour.
  const [remeasure, setRemeasure] = useState(0);
  const goto = useCallback((idx, dir) => {
    // A backward auto-skip that hits the front flips forward: without this,
    // a missing-target step 0 would clamp to itself forever (frozen Back).
    dirRef.current = idx < 0 ? 1 : dir;
    if (idx < 0) idx = 0;
    if (idx >= steps.length) { close(true); return; }
    setChaptersOpen(false);
    if (idx === i) setRemeasure((n) => n + 1);
    else setI(idx);
  }, [steps.length, close, i]);

  // Reset to the first step whenever the tour opens fresh.
  useEffect(() => { if (open) { setI(0); dirRef.current = 1; closedRef.current = false; } }, [open]);

  // Keep focus on the card so nothing beneath the overlay can hold it.
  useEffect(() => { if (open) cardRef.current?.focus?.(); }, [open, i]);

  // Measure the current step's target; skip (in travel direction) if absent.
  useLayoutEffect(() => {
    if (!open || !step) return;
    try { step.prep?.(ctx); } catch { /* prep is best-effort */ }
    const raf = requestAnimationFrame(() => {
      if (step.target === null) { setRect(null); return; }
      const el = document.querySelector(step.target);
      if (!el) { goto(i + dirRef.current, dirRef.current); return; }
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      setRect(el.getBoundingClientRect());
    });
    return () => cancelAnimationFrame(raf);
  }, [open, i, remeasure, step, ctx, goto]);

  // Re-measure on window resize.
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

  // Keyboard: arrows advance, Esc leaves. Capture phase so terminals never
  // see it, and stopPropagation so nothing beneath the overlay (a focused
  // input in a stray modal, xterm) receives the same keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); goto(i + 1, 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); goto(i - 1, -1); }
      else if (e.key === "Tab") {
        // Hard focus trap: Tab cycles INSIDE the card only. Without this, Tab
        // walks focus onto real chrome under the overlay and Space activates
        // it natively (keyup semantics the keydown branches never see) —
        // theme toggles, modals opening invisibly (re-review finding).
        const node = cardRef.current;
        if (!node) return;
        e.preventDefault(); e.stopPropagation();
        const items = focusablesIn(node);
        if (items.length === 0) { node.focus(); return; }
        const at = items.indexOf(document.activeElement);
        if (at === -1) { items[0].focus(); return; }
        items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, i, goto, close]);

  if (!open || !step) return null;

  const vp = { w: window.innerWidth, h: window.innerHeight };
  const p = pickPlacement(rect, CARD, vp);
  const centered = !rect || step.target === null;

  return (
    <div className="phn-tour" role="presentation">
      {!centered ? (
        <>
          <div className="phn-tour-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - PAD) }} />
          <div className="phn-tour-dim" style={{ top: rect.bottom + PAD, left: 0, right: 0, bottom: 0 }} />
          <div className="phn-tour-dim" style={{ top: Math.max(0, rect.top - PAD), left: 0, width: Math.max(0, rect.left - PAD), height: rect.height + PAD * 2 }} />
          <div className="phn-tour-dim" style={{ top: Math.max(0, rect.top - PAD), left: rect.right + PAD, right: 0, height: rect.height + PAD * 2 }} />
          <div className="phn-tour-ring" style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }} />
        </>
      ) : (
        <div className="phn-tour-dim" style={{ inset: 0 }} />
      )}
      <div
        className="phn-tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Tour step ${i + 1} of ${steps.length}: ${step.title}`}
        ref={cardRef}
        tabIndex={-1}
        style={{ left: p.x, top: p.y, width: CARD.w, outline: "none" }}
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
            <button className="phn-tour-btn quiet" onClick={() => close(false)}>Skip</button>
          </span>
        </div>
        {chaptersOpen && (
          <div className="phn-tour-chlist">
            {chapters.map((c) => {
              const first = steps.findIndex((s) => s.chapter === c);
              if (first < 0) return null;
              return (
                <button key={c} className={c === step.chapter ? "phn-tour-chitem active" : "phn-tour-chitem"} onClick={() => goto(first, 1)}>
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
