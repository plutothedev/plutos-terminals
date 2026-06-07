// (C)
// App-owned prompt editor (Milestone 2, slice 1). A CodeMirror overlay that owns
// the shell's input line while the shell is at a prompt: live shell syntax
// highlighting, Enter sends the line to the PTY, ↑/↓ walk the app history, Esc
// hands focus back to the terminal. Positioned by the parent at the prompt's
// input origin; only mounted when the feature is on AND the pane is at a prompt
// (not running a command, not in a full-screen app). See the design spec.

import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags as t } from "@lezer/highlight";
import { getCommandHistory } from "./ptyBridge.js";

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
    "&": { backgroundColor: "transparent", color: c.foreground || "#d0d0d0", fontSize: "inherit" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": { padding: 0, fontFamily: "inherit", caretColor: c.cursor || c.foreground || "#d0d0d0" },
    ".cm-line": { padding: 0 },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.cursor || c.foreground || "#d0d0d0" },
    "&.cm-editor": { backgroundColor: "transparent" },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "hidden" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: c.selectionBackground || "rgba(120,140,200,0.35)" },
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

    const singleLine = EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged) return tr;
      const next = tr.newDoc.toString();
      if (next.includes("\n")) {
        const flat = next.replace(/\n+/g, " ");
        return { changes: { from: 0, to: tr.startState.doc.length, insert: flat }, selection: { anchor: flat.length } };
      }
      return tr;
    });

    const histPrev = (v) => {
      const h = histRef.current;
      if (h.pos === -1) h.draft = v.state.doc.toString();
      if (h.pos + 1 >= h.list.length) return true;
      h.pos += 1;
      setDoc(h.list[h.pos] || "");
      return true;
    };
    const histNext = (v) => {
      const h = histRef.current;
      if (h.pos <= -1) return true;
      h.pos -= 1;
      setDoc(h.pos === -1 ? h.draft : (h.list[h.pos] || ""));
      return true;
    };

    const km = keymap.of([
      { key: "Enter", run: (v) => { cbRef.current.onSubmit?.(v.state.doc.toString()); return true; } },
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
        singleLine,
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
