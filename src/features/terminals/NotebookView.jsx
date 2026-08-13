// (C)
// Notebook tab view (Task C-4) — a runnable markdown notebook. Replaces the
// C-3 stub. Two surfaces side by side:
//   • EDITOR (left): lazy-loaded Monaco (markdown), textarea fallback on load
//     failure — the exact RemoteEditor.jsx pattern. Local `content` string +
//     a `contentRef` mirror; EVERY async writer (save, run write-back, unmount
//     flush) reads contentRef.current, never a closed-over `content`, because a
//     run can take up to 120 s and edits made meanwhile must not be clobbered.
//     Dirty flag; Ctrl/Cmd+S save; 2 s debounced autosave after the last edit;
//     fire-and-forget save-on-unmount when dirty (the hard-quit gap — tray→Quit
//     killing the process before the invoke lands — is DOCUMENTED/accepted, per
//     the plan; the debounce bounds routine exposure to ≤2 s).
//   • RUN RAIL (right): one row per shell block (parseBlocks). Lang, the first
//     code line, a Run button, and the block's owned-output exit badge. A
//     target-pane dropdown fed by getLiveTabIds() drives where blocks execute —
//     no hidden global resolution. Run All is sequential, stop-on-failure.
//
// SAFETY / no-auto-run: nothing executes on open, load, or restore — only an
// explicit Run/Run-All click sends anything to a pane. v1 runs SINGLE-LINE
// blocks only (runnableKind); multi-line / incomplete-line blocks are
// display-only ("runs in v1.1"), never sent — this closes the continuation-hang
// class (except the documented unclosed-quote/paren residual in notebookModel).
//
// BLOCK-INDEX RACE (carried from the C-2 review): block.index is a sequential
// ordinal recomputed per parse; if the doc changed mid-run, writing output at
// index N could misattribute it. GUARD CHOSEN: disable editing while any run is
// in flight (Monaco readOnly + textarea disabled) — the document cannot change
// between run-start and write-back, so the race cannot occur. As belt-and-
// suspenders we ALSO reparse contentRef.current at write-back and verify the
// block at that index still has the same `code`; on mismatch we DISCARD the
// write (a "block changed during run" note) rather than misattribute. No silent
// misattribution either way.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { noteWrite, readNotebook } from "./notebookIo.js";
import { parseBlocks, writeOutput, setFrontmatterTarget, runnableKind, runnableLines } from "./notebookModel.js";
import { runAndCapture, getLiveTabIds, subscribeRegistry, getRegistryVersion } from "./ptyBridge.js";
import { useToast } from "../../components/Toast.jsx";

// ── isNew signal ────────────────────────────────────────────────────────────
// NotebookView gets only { name, tabId, visible } (the render arm in
// TerminalPanel.jsx is out of this task's edit scope), so it cannot be told via
// props whether a read failure means "brand-new file, seed a template" or
// "restored tab whose file went missing, warn — do NOT reseed over lost
// content". The only durable difference is provenance: a creation goes through
// addNotebookTab (a live action this session), a restore is rehydrated straight
// from persisted state. So addNotebookTab (useWorkspaceTree.js) marks the name
// here on creation; NotebookView consumes the mark once on mount. A read that
// SUCCEEDS ignores the mark entirely (never seeds over real content).
const pendingNewNotebooks = new Set();
export function markNotebookNew(name) {
  if (name) pendingNewNotebooks.add(name);
}
function consumeNotebookNew(name) {
  const had = pendingNewNotebooks.has(name);
  pendingNewNotebooks.delete(name);
  return had;
}

const AUTOSAVE_MS = 2000;

function baseName(name) {
  return String(name || "notebook").replace(/\.md$/i, "");
}

// Template seeded into a brand-new notebook (creation + read-miss only).
function seedTemplate(name) {
  const title = baseName(name);
  return (
    "# " + title + "\n\n" +
    "Shell code blocks below run in the target pane you pick on the right.\n" +
    "Each block's output is written back beneath it as an `output` fence and is\n" +
    "OVERWRITTEN on every rerun. v1 runs single-line blocks only.\n\n" +
    "```sh\n" +
    "echo \"hello from plutos-terminals\"\n" +
    "```\n"
  );
}

// runnableLines now comes from notebookModel.js (release-audit dedupe): the
// reduction that picks the line to SEND is the same code that classifies
// runnability — the two can no longer drift apart.

// A block v1 will actually SEND to a pane: classified "single" AND carrying
// exactly one runnable line. runnableKind also returns "single" for a block
// with ZERO runnable lines (only blanks / sh-comments) — that has nothing to
// run, so its Run button stays disabled and it never counts toward Run All (a
// null-line run must not be mistaken for a failed run and halt the batch).
function isRunnableSingle(code, lang) {
  return runnableKind(code, lang) === "single" && runnableLines(code, lang).length > 0;
}

// The first non-empty line of a block's code, for the rail row label.
function firstCodeLine(code) {
  const lines = String(code ?? "").split(/\r\n|\r|\n/);
  for (const l of lines) {
    const t = l.trim();
    if (t) return t;
  }
  return "";
}

// The exit value persisted in a block's owned output fence header
// ("```output (<ts>, exit <exit>)"), or null when there's no owned fence — this
// is what shows the exit badge on reopen, before any run this session.
function persistedExit(text, outputFence) {
  if (!outputFence) return null;
  const slice = text.slice(outputFence.start, outputFence.end);
  const nl = slice.indexOf("\n");
  const header = nl === -1 ? slice : slice.slice(0, nl);
  const m = /exit\s+([^)]+)\)/.exec(header);
  return m ? m[1].trim() : null;
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A run's exit counts as a failure (stops Run All) when the pane timed out, the
// numeric exit is nonzero, nothing was captured (r === null — dead writer), or
// the capture was evicted by another run taking the pane ({evicted:true}).
function isFailure(r) {
  if (r == null) return true;
  if (r.evicted) return true;
  if (r.timedOut) return true;
  return typeof r.exit === "number" && r.exit !== 0;
}

const ACCENT = "var(--phn-link, #7c9cf5)";
const DANGER = "var(--phn-danger, #e08784)";
const OK = "#7fbf8a";
const DIM = "var(--phn-text-faint, #586068)";
const FG = "var(--phn-text-active, #E6E6E6)";
const MONO = "'JetBrains Mono', Menlo, Monaco, monospace";

export default function NotebookView({ name, tabId, visible, paneTitles }) {
  const toast = useToast();

  const [content, setContent] = useState(null); // null = loading
  const [savedContent, setSavedContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false); // restored tab, file missing
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState({}); // block.index -> "running"|"skipped"|"changed"
  const [targetId, setTargetId] = useState(null);
  const [Editor, setEditor] = useState(null); // Monaco component once loaded
  const [monacoFailed, setMonacoFailed] = useState(false);

  // Refs the async writers read (never a closed-over render value).
  const contentRef = useRef(null);
  const savedRef = useRef("");
  const dirtyRef = useRef(false);
  const nameRef = useRef(name);
  const savingRef = useRef(false);
  // Guards async run/save continuations that resolve AFTER unmount: a
  // runAndCapture can take up to 120 s, and if the tab closes meanwhile the
  // resolved closure must NOT setState or arm a fresh autosave that later writes
  // stale content over a reopened+edited file (zombie write). Set false on
  // unmount; every writer checks it after its await.
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const autosaveTimer = useRef(null);
  const fmTargetRef = useRef(null); // frontmatter targetPane read at load
  const saveRef = useRef(() => {});

  nameRef.current = name;

  const dirty = content != null && content !== savedContent;
  dirtyRef.current = dirty;

  const parsed = useMemo(() => parseBlocks(content || ""), [content]);

  // Live PTY panes, refreshed on pane spawn/close (registry channel — the
  // dims channel would re-derive this on every resize for nothing; P2-T5).
  const bridgeV = useSyncExternalStore(subscribeRegistry, getRegistryVersion);
  const liveIds = useMemo(() => getLiveTabIds(), [bridgeV]);
  const targetLive = !!targetId && liveIds.includes(targetId);

  const singleCount = useMemo(
    () => parsed.blocks.filter((b) => isRunnableSingle(b.code, b.lang)).length,
    [parsed],
  );

  // ── Lazy Monaco (RemoteEditor pattern) ────────────────────────────────────
  // Gated on `visible` (P4-T1): tabs are never unmounted (display:none only),
  // so without the gate a restored notebook in a HIDDEN tab pulled the full
  // ~3.9MB Monaco chain at boot. `visible` in the deps is load-bearing — the
  // effect must re-run when the tab is first revealed.
  useEffect(() => {
    if (!visible || Editor || monacoFailed) return;
    let alive = true;
    (async () => {
      try {
        await import("./monacoSetup.js"); // side effects: local monaco + workers
        const mod = await import("@monaco-editor/react");
        if (alive) setEditor(() => mod.default);
      } catch {
        if (alive) setMonacoFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [visible, Editor, monacoFailed]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const scheduleAutosave = useCallback(() => {
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { saveRef.current(); }, AUTOSAVE_MS);
  }, []);

  const save = useCallback(async () => {
    if (savingRef.current) {
      // BUSY-SKIP case: this request would be dropped by the mutex. Re-arm so
      // the latest content still lands once the in-flight write releases (the
      // mutex-race the autosave otherwise strands). Bounded: a save always
      // clears savingRef in its finally, so a write can't be busy forever.
      // Guarded on mountedRef so a post-unmount timer can't arm a stale write.
      if (mountedRef.current) scheduleAutosave();
      return;
    }
    const snapshot = contentRef.current;
    if (snapshot == null) return;
    if (snapshot === savedRef.current) return; // nothing to persist
    savingRef.current = true;
    setSaving(true);
    try {
      await noteWrite(name, snapshot);
      savedRef.current = snapshot;
      setSavedContent(snapshot);
    } catch (e) {
      // FAILED-WRITE case: deliberately do NOT re-arm here. A persistent error
      // (disk full, permission, dir-scope reject) would otherwise self-retry
      // every 2 s forever with a toast each cycle. A failed save waits for an
      // explicit user action (next keystroke's onChange → scheduleAutosave, or
      // Ctrl+S). Only the busy-skip branch above re-arms.
      toast.error(`Notebook save failed: ${e}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [name, toast, scheduleAutosave]);
  saveRef.current = save;

  // Single funnel for every content mutation (editor edits, output write-back,
  // frontmatter target change): keep contentRef in lockstep and (re)arm autosave.
  const updateContent = useCallback((v) => {
    const s = v ?? "";
    contentRef.current = s;
    setContent(s);
    scheduleAutosave();
  }, [scheduleAutosave]);

  // ── Load on mount / name change ───────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError(false);
    setRunStatus({});
    setContent(null);
    contentRef.current = null;
    // readNotebook (not a bare invoke) waits for any in-flight write to the SAME
    // name to land before reading — so a close->reopen of one notebook loads the
    // closing view's final content, never a pre-edit snapshot.
    readNotebook(name)
      .then((text) => {
        if (!alive) return;
        // A "New notebook" name that collided with an existing file lands here
        // (the read succeeds and loads the existing content — correct); clear
        // its pending-new marker or it leaks in the module Set for the app's
        // lifetime (release-audit minor).
        consumeNotebookNew(name);
        const s = typeof text === "string" ? text : "";
        contentRef.current = s;
        savedRef.current = s;
        setContent(s);
        setSavedContent(s);
        fmTargetRef.current = parseBlocks(s).frontmatter.targetPane || null;
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        if (consumeNotebookNew(name)) {
          // Brand-new notebook: seed a template. savedContent stays "" so the
          // seed reads dirty and autosave materializes the file on disk.
          const seed = seedTemplate(name);
          contentRef.current = seed;
          savedRef.current = "";
          setContent(seed);
          setSavedContent("");
          fmTargetRef.current = null;
          scheduleAutosave();
        } else {
          // Restored tab whose file is gone: empty editor + warning banner.
          // NEVER reseed a template over what used to have content.
          contentRef.current = "";
          savedRef.current = "";
          setContent("");
          setSavedContent("");
          fmTargetRef.current = null;
          setLoadError(true);
        }
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a valid target pane selected: honor a still-live user choice; else the
  // frontmatter target if live; else the first live pane; else none. Never
  // clobbers a live selection, so it doesn't fight the dropdown. Only an
  // explicit pick (onPickTarget) writes back to frontmatter.
  useEffect(() => {
    if (!loaded) return;
    setTargetId((cur) => {
      if (cur && liveIds.includes(cur)) return cur;
      const fmT = fmTargetRef.current;
      if (fmT && liveIds.includes(fmT)) return fmT;
      return liveIds[0] ?? null;
    });
  }, [loaded, liveIds]);

  // ── Ctrl/Cmd+S (only the visible notebook responds) ───────────────────────
  useEffect(() => {
    if (!visible) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, save]);

  // ── Mount flag + save-on-unmount when dirty ───────────────────────────────
  // mountedRef re-asserts true on every mount and flips false on unmount, so
  // in-flight run/save continuations bail instead of firing a zombie write
  // after this instance is gone. Re-asserting at the TOP is load-bearing under
  // React 18 StrictMode: its dev-only mount→cleanup→remount cycle would
  // otherwise leave the ref stuck false forever (useRef's initializer runs once;
  // the synthetic remount reuses the same ref object) — which would make Run
  // look dead in every `tauri dev` smoke. The []-deps body runs on every real
  // AND synthetic mount; the cleanup runs only on a true unmount. Mirrors the
  // per-run `let alive = true` idiom used by the two effects below.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(autosaveTimer.current);
      if (dirtyRef.current && contentRef.current != null) {
        // Final flush through noteWrite so a reopen of this name serializes
        // behind it (see readNotebook). A valid name won't fail the gate here
        // (the New-notebook path sanitizes up front), but a genuine disk error
        // must NOT vanish silently — log it instead of swallowing.
        noteWrite(nameRef.current, contentRef.current).catch((e) => {
          try { console.error("notebook final save failed", e); } catch { /* console unavailable */ }
        });
      }
    };
  }, []);

  // ── Target-pane pick (writes frontmatter, marks dirty) ────────────────────
  const onPickTarget = useCallback((id) => {
    setTargetId(id);
    fmTargetRef.current = id;
    if (contentRef.current != null && id) {
      updateContent(setFrontmatterTarget(contentRef.current, id));
    }
  }, [updateContent]);

  // ── Run one block (single-line only) ──────────────────────────────────────
  // Returns the run result so Run All can decide whether to stop.
  const runOne = useCallback(async (blockIndex) => {
    const atStart = parseBlocks(contentRef.current || "");
    const block = atStart.blocks[blockIndex];
    // { skipped } is a non-failure sentinel: it must not read as a failed run
    // and stop Run All (only a real null/timeout/nonzero exit does).
    if (!block || !isRunnableSingle(block.code, block.lang)) return { skipped: true };
    const theLine = runnableLines(block.code, block.lang)[0] ?? "";
    const capturedCode = block.code;

    setRunStatus((s) => ({ ...s, [blockIndex]: "running" }));
    const r = await runAndCapture(targetId, theLine);
    // Unmounted mid-run (tab closed during the up-to-120 s capture): bail BEFORE
    // any setState / writeOutput / scheduleAutosave, or we'd arm a timer that
    // later clobbers a reopened+edited file with this instance's stale content.
    if (!mountedRef.current) return r;

    // Defensive reparse-verify (editing is locked during a run, so this should
    // always match; it's the no-silent-misattribution backstop).
    const after = parseBlocks(contentRef.current || "");
    const cur = after.blocks[blockIndex];
    if (!cur || cur.code !== capturedCode) {
      setRunStatus((s) => ({ ...s, [blockIndex]: "changed" }));
      return r;
    }

    // Spec'd diagnostic markers: a closed pane and an evicted capture must not
    // masquerade as generic "(no output captured)".
    const next = writeOutput(contentRef.current, blockIndex, {
      output:
        r === null
          ? "(pane closed)"
          : r?.evicted
            ? "(capture superseded by another run on this pane)"
            : (r?.output ?? "(no output captured)"),
      exit: r?.timedOut ? "timeout" : (r?.exit ?? "?"),
      timestamp: nowStamp(),
    });
    updateContent(next);
    setRunStatus((s) => {
      const c = { ...s };
      delete c[blockIndex]; // persisted exit badge takes over from here
      return c;
    });
    return r;
  }, [targetId, updateContent]);

  const runBlock = useCallback(async (blockIndex) => {
    if (runningRef.current || !targetLive) return;
    runningRef.current = true;
    setRunning(true);
    try {
      await runOne(blockIndex);
    } finally {
      if (mountedRef.current) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  }, [targetLive, runOne]);

  const runAll = useCallback(async () => {
    if (runningRef.current || !targetLive) return;
    const blocks = parseBlocks(contentRef.current || "").blocks;
    const singleIdx = blocks.filter((b) => isRunnableSingle(b.code, b.lang)).map((b) => b.index);
    // Fresh transient state: multi-line / incomplete blocks visibly "skipped
    // (v1.1)". (An empty single block — nothing to run — gets no marker.)
    const skipped = {};
    for (const b of blocks) {
      if (runnableKind(b.code, b.lang) === "multiline") skipped[b.index] = "skipped";
    }
    setRunStatus(skipped);
    runningRef.current = true;
    setRunning(true);
    try {
      for (const idx of singleIdx) {
        const r = await runOne(idx);
        if (!mountedRef.current) break; // unmounted mid-batch: stop firing further blocks
        if (isFailure(r)) break; // stop at first nonzero exit / timeout / dead pane
      }
    } finally {
      if (mountedRef.current) {
        runningRef.current = false;
        setRunning(false);
        // Revert the transient "skipped" markers to their steady "runs in v1.1"
        // rail text; preserve any "changed" discards so the user still sees them.
        setRunStatus((s) => {
          let touched = false;
          const c = {};
          for (const k in s) {
            if (s[k] === "skipped") { touched = true; continue; }
            c[k] = s[k];
          }
          return touched ? c : s;
        });
      }
    }
  }, [targetLive, runOne]);

  // ── Render ────────────────────────────────────────────────────────────────
  const useMonaco = Editor && !monacoFailed;
  const savedLabel = saving ? "Saving…" : dirty ? "Unsaved" : "Saved";

  return (
    <div
      data-tab-id={tabId}
      data-notebook-visible={visible ? "1" : "0"}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        background: "var(--phn-page-bg, #0a0a0a)",
        color: FG,
      }}
    >
      {/* Header: name + dirty dot + save state + Save button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          fontFamily: "var(--phn-ui-font, inherit)",
          borderBottom: "1px solid var(--phn-surface-border, rgba(255,255,255,0.08))",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: FG, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {dirty ? "● " : ""}{name}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: DIM, fontFamily: MONO }}>{savedLabel}</span>
        <button
          onClick={save}
          disabled={saving || !dirty}
          title="Save (Ctrl/Cmd+S)"
          style={{
            background: saving || !dirty ? "transparent" : ACCENT,
            border: `1px solid ${ACCENT}`,
            color: saving || !dirty ? DIM : "#06223a",
            padding: "3px 12px", borderRadius: 4, fontSize: 11.5, fontWeight: 600,
            cursor: saving || !dirty ? "default" : "pointer", fontFamily: "var(--phn-ui-font, inherit)",
          }}
        >
          Save
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Editor column */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {loadError && (
            <div
              style={{
                padding: "8px 12px",
                fontSize: 11.5,
                fontFamily: "var(--phn-ui-font, inherit)",
                color: DANGER,
                background: "rgba(224, 135, 132, 0.10)",
                borderBottom: `1px solid ${DANGER}`,
              }}
            >
              notebook file not found — it may have been moved or deleted
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            {content == null ? (
              <div style={{ padding: 16, color: DIM, fontSize: 12, fontFamily: MONO }}>Loading {name}…</div>
            ) : useMonaco ? (
              <Editor
                height="100%"
                theme="vs-dark"
                language="markdown"
                value={content}
                onChange={(v) => updateContent(v ?? "")}
                loading={<div style={{ padding: 16, color: DIM, fontSize: 12 }}>Starting editor…</div>}
                options={{
                  readOnly: running,
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  wordWrap: "on",
                  fontFamily: "'MesloLGS NF', 'JetBrains Mono', monospace",
                }}
              />
            ) : (
              <textarea
                value={content}
                onChange={(e) => updateContent(e.target.value)}
                disabled={running}
                spellCheck={false}
                placeholder={monacoFailed ? "" : "Loading editor…"}
                style={{
                  width: "100%", height: "100%", boxSizing: "border-box", resize: "none",
                  background: "var(--phn-page-bg, #1c1c1c)", color: "var(--phn-text-fg, #d4d4d4)",
                  border: "none", outline: "none", padding: 10,
                  fontFamily: "'MesloLGS NF', 'JetBrains Mono', monospace", fontSize: 13, lineHeight: 1.5,
                }}
              />
            )}
          </div>
        </div>

        {/* Run rail */}
        <div
          style={{
            width: 300,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid var(--phn-surface-border, rgba(255,255,255,0.08))",
            background: "var(--phn-surface-bg, #0f0f0f)",
            minHeight: 0,
          }}
        >
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--phn-surface-border, rgba(255,255,255,0.08))", flexShrink: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: DIM, marginBottom: 6, fontFamily: "var(--phn-ui-font, inherit)" }}>
              Target pane
            </div>
            <select
              value={targetLive ? targetId : ""}
              onChange={(e) => onPickTarget(e.target.value)}
              disabled={running || liveIds.length === 0}
              style={{
                width: "100%",
                background: "var(--phn-page-bg, #161616)",
                color: FG,
                border: "1px solid var(--phn-surface-border, rgba(255,255,255,0.14))",
                borderRadius: 4,
                padding: "4px 6px",
                fontSize: 11,
                fontFamily: MONO,
              }}
            >
              {/* Display titles, not raw internal pane ids: paneTitles maps each
                  leaf id to its tab label ("api-server", "api-server · 2" for
                  splits); "Terminal N" covers an id the map doesn't know yet. */}
              {liveIds.length === 0 && <option value="">no live terminal panes</option>}
              {!targetLive && targetId && <option value="">{paneTitles?.[targetId] ? `${paneTitles[targetId]} (offline)` : "closed pane"}</option>}
              {liveIds.map((id, i) => (
                <option key={id} value={id}>{paneTitles?.[id] || `Terminal ${i + 1}`}</option>
              ))}
            </select>
            <button
              onClick={runAll}
              disabled={running || !targetLive || singleCount === 0}
              title={!targetLive ? "Pick a live terminal pane first" : singleCount === 0 ? "No single-line blocks to run" : "Run all single-line blocks, top to bottom"}
              style={{
                marginTop: 8,
                width: "100%",
                background: running || !targetLive || singleCount === 0 ? "transparent" : ACCENT,
                border: `1px solid ${ACCENT}`,
                color: running || !targetLive || singleCount === 0 ? DIM : "#06223a",
                padding: "4px 10px", borderRadius: 4, fontSize: 11.5, fontWeight: 600,
                cursor: running || !targetLive || singleCount === 0 ? "default" : "pointer",
                fontFamily: "var(--phn-ui-font, inherit)",
              }}
            >
              {running ? "Running…" : "Run All"}
            </button>
            {!targetLive && liveIds.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 10, color: DIM, fontFamily: "var(--phn-ui-font, inherit)" }}>
                Select a live pane to run blocks.
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {parsed.blocks.length === 0 ? (
              <div style={{ padding: "12px 10px", fontSize: 11, color: DIM, fontFamily: "var(--phn-ui-font, inherit)" }}>
                No shell blocks yet. Add a fenced code block (sh, bash, powershell, pwsh, or cmd) to make it runnable.
              </div>
            ) : (
              parsed.blocks.map((block) => {
                const kind = runnableKind(block.code, block.lang);
                const status = runStatus[block.index];
                const exit = persistedExit(content || "", block.outputFence);
                const lineCount = runnableLines(block.code, block.lang).length;
                const isRunnable = kind === "single" && lineCount > 0;

                let note = null;
                if (status === "running") note = { text: "running…", color: ACCENT };
                else if (status === "changed") note = { text: "block changed during run — output discarded", color: DANGER };
                else if (status === "skipped") note = { text: "skipped (multi-line)", color: DIM };
                else if (kind === "multiline") note = { text: lineCount <= 1 ? "incomplete line — not supported yet" : "multi-line — not supported yet", color: DIM };
                else if (!isRunnable) note = { text: "nothing to run", color: DIM };
                else if (exit != null) note = { text: `exit ${exit}`, color: exit === "0" ? OK : DANGER };

                return (
                  <div
                    key={block.index}
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--phn-surface-border, rgba(255,255,255,0.05))",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          fontSize: 9,
                          textTransform: "uppercase",
                          letterSpacing: 0.4,
                          color: DIM,
                          border: `1px solid ${DIM}`,
                          borderRadius: 3,
                          padding: "0 4px",
                          flexShrink: 0,
                        }}
                      >
                        {block.lang}
                      </span>
                      <span
                        title={firstCodeLine(block.code)}
                        style={{
                          flex: 1,
                          fontSize: 11,
                          fontFamily: MONO,
                          color: FG,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {firstCodeLine(block.code) || "(empty)"}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        onClick={() => runBlock(block.index)}
                        disabled={running || !isRunnable || !targetLive}
                        title={
                          !isRunnable
                            ? "Only single, complete shell lines can run"
                            : !targetLive
                              ? "Pick a live terminal pane first"
                              : "Run this block in the target pane"
                        }
                        style={{
                          background: running || !isRunnable || !targetLive ? "transparent" : ACCENT,
                          border: `1px solid ${running || !isRunnable || !targetLive ? DIM : ACCENT}`,
                          color: running || !isRunnable || !targetLive ? DIM : "#06223a",
                          padding: "2px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                          cursor: running || !isRunnable || !targetLive ? "default" : "pointer",
                          fontFamily: "var(--phn-ui-font, inherit)",
                          flexShrink: 0,
                        }}
                      >
                        Run
                      </button>
                      {note && (
                        <span style={{ fontSize: 10, color: note.color, fontFamily: "var(--phn-ui-font, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {note.text}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
