// (C)
// App-owned prompt editor (Milestone 2, slice 1). A CodeMirror overlay that owns
// the shell's input line while the shell is at a prompt: live shell syntax
// highlighting, Enter sends the line to the PTY, ↑/↓ walk the app history, Esc
// hands focus back to the terminal. Positioned by the parent at the prompt's
// input origin; only mounted when the feature is on AND the pane is at a prompt
// (not running a command, not in a full-screen app). See the design spec.

import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags as t } from "@lezer/highlight";
import { getCommandHistory } from "./ptyBridge.js";
import { MONO_STACK } from "./fonts.js";

// ── Ghost-text autosuggest (fish/Warp style) ────────────────────────────────
// As you type, show the best command-history match as grey inline text after the
// cursor; →/End/Tab accepts it. Suggestion shows only when the caret is at the
// end of a single-line draft (no selection), so it never fights multiline edits.
class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-ghost";
    s.textContent = this.text;
    return s;
  }
  ignoreEvent() { return false; }
}

const ghostPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.ghost = ""; this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view); }
    build(view) {
      this.ghost = "";
      const { state } = view;
      const sel = state.selection.main;
      const text = state.doc.toString();
      // single line, caret at very end, nothing selected
      if (!text || state.doc.lines > 1 || !sel.empty || sel.head !== state.doc.length) return Decoration.none;
      const match = getCommandHistory().find((h) => h.length > text.length && h.startsWith(text));
      if (!match) return Decoration.none;
      this.ghost = match.slice(text.length);
      const deco = Decoration.widget({ widget: new GhostWidget(this.ghost), side: 1 });
      return Decoration.set([deco.range(sel.head)]);
    }
  },
  { decorations: (v) => v.decorations }
);

function acceptGhost(view) {
  const p = view.plugin(ghostPlugin);
  if (!p || !p.ghost) return false;
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, insert: p.ghost }, selection: { anchor: end + p.ghost.length } });
  return true;
}

// Build a highlight style from the active xterm theme so the prompt matches the
// terminal's colors (and any custom theme).
function highlightFor(theme) {
  const c = theme || {};
  return HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: c.brightBlue || c.blue || "#5f87ff" },
    { tag: [t.string, t.special(t.string)], color: c.green || "#5fd75f" },
    { tag: t.comment, color: c.brightBlack || "#777", fontStyle: "italic" },
    { tag: [t.number, t.atom, t.bool], color: c.yellow || "#e5e510" },
    { tag: [t.variableName, t.propertyName], color: c.cyan || "#5fd7d7" },
    { tag: [t.operator, t.punctuation], color: c.brightBlack || "#9aa" },
    { tag: t.meta, color: c.magenta || "#d75fd7" },
  ]);
}

function editorTheme(theme) {
  const c = theme || {};
  return EditorView.theme({
    "&": { backgroundColor: "transparent", color: c.foreground || "#d0d0d0", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": { padding: 0, fontFamily: MONO_STACK, caretColor: c.cursor || c.foreground || "#d0d0d0" },
    ".cm-line": { padding: 0 },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.cursor || c.foreground || "#d0d0d0" },
    "&.cm-editor": { backgroundColor: "transparent" },
    ".cm-scroller": { fontFamily: MONO_STACK, lineHeight: "inherit", overflow: "hidden" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: c.selectionBackground || "rgba(120,140,200,0.35)" },
    ".cm-ghost": { color: c.brightBlack || "#6b7280", opacity: 0.7 },
  }, { dark: true });
}

export default function PromptEditor({ visible, top, left, width, height, theme, onSubmit, onEscape, onCtrlC, onClear }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const themeComp = useRef(new Compartment());
  // History navigation state (snapshotted when the editor is shown).
  const histRef = useRef({ list: [], pos: -1, draft: "" });
  // Latest callbacks, read by the stable keymap without re-creating the view.
  const cbRef = useRef({});
  cbRef.current = { onSubmit, onEscape, onCtrlC, onClear };

  const setDoc = (text) => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } });
  };

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;

    // ArrowUp/Down walk history only at the first/last line; otherwise they move
    // the caret between lines (multiline composing).
    const histPrev = (v) => {
      const { state } = v;
      if (state.doc.lineAt(state.selection.main.head).number !== 1) return false;
      const h = histRef.current;
      if (h.pos === -1) h.draft = state.doc.toString();
      if (h.pos + 1 >= h.list.length) return true;
      h.pos += 1;
      setDoc(h.list[h.pos] || "");
      return true;
    };
    const histNext = (v) => {
      const { state } = v;
      if (state.doc.lineAt(state.selection.main.head).number !== state.doc.lines) return false;
      const h = histRef.current;
      if (h.pos <= -1) return true;
      h.pos -= 1;
      setDoc(h.pos === -1 ? h.draft : (h.list[h.pos] || ""));
      return true;
    };

    const km = keymap.of([
      { key: "Enter", run: (v) => { cbRef.current.onSubmit?.(v.state.doc.toString()); return true; } },
      { key: "Shift-Enter", run: insertNewlineAndIndent },
      { key: "Tab", run: (v) => { acceptGhost(v); return true; } }, // accept ghost; swallow tab otherwise
      { key: "ArrowRight", run: acceptGhost }, // accept at end; else default cursor move
      { key: "End", run: acceptGhost },
      { key: "ArrowUp", run: histPrev },
      { key: "ArrowDown", run: histNext },
      { key: "Escape", run: () => { cbRef.current.onEscape?.(); return true; } },
      { key: "Ctrl-c", run: (v) => { if (!v.state.selection.main.empty) return false; cbRef.current.onCtrlC?.(); return true; } },
      { key: "Ctrl-l", run: () => { cbRef.current.onClear?.(); return true; } },
    ]);

    const state = EditorState.create({
      doc: "",
      extensions: [
        km,
        ghostPlugin,
        StreamLanguage.define(shell),
        themeComp.current.of([editorTheme(theme), syntaxHighlighting(highlightFor(theme))]),
        EditorView.lineWrapping,
      ],
    });
    viewRef.current = new EditorView({ state, parent: hostRef.current });
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme on theme change.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: themeComp.current.reconfigure([editorTheme(theme), syntaxHighlighting(highlightFor(theme))]) });
  }, [theme]);

  // On show: snapshot history, clear the draft, focus.
  useEffect(() => {
    if (!visible) return;
    histRef.current = { list: getCommandHistory(), pos: -1, draft: "" };
    setDoc("");
    const v = viewRef.current;
    if (v) setTimeout(() => v.focus(), 0);
  }, [visible]);

  return (
    <div
      ref={hostRef}
      data-prompt-editor
      style={{
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        minHeight: `${height}px`,
        display: visible ? "block" : "none",
        zIndex: 6,
        font: "inherit",
        lineHeight: "inherit",
      }}
      // Keep clicks inside from bubbling to the terminal focus handler.
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
