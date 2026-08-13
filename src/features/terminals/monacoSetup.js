// (C)
// Configure @monaco-editor/react to use the BUNDLED monaco-editor (never the
// CDN — this is an offline desktop app) and wire its web workers through Vite's
// ?worker imports so language features work inside Tauri's webview. Imported
// once for its side effects before any <Editor> mounts.
//
// SLIM build (P4-T6): the old `import * as monaco from "monaco-editor"` barrel
// dragged the full editor.main — every rich language service — into dist:
// ts.worker 6.9MB + css.worker 1.05MB + html.worker 0.72MB shipped for a
// markdown notebook + occasional remote-file edits. Now: editor.all (every
// editor FEATURE — find, folding, suggest, context menu — but zero languages)
// + exactly the basic-language tokenizers languageForFile maps. css/html/ts
// demote to basic tokenization (colors, no intellisense) and their workers
// vanish from dist.
//
// DELIBERATE deviation from the rev-3 plan (which said drop json's pair too):
// monaco 0.55 has NO basic-languages/json — the plan's "still colored via
// basic" premise fails there; plaintext package.json in the remote editor is
// a real downgrade. So the rich JSON pair stays, BOTH halves together (the
// audit-H2 consistency rule: a language lives in the worker map AND the mode
// registration, or in neither).
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution"; // registers BOTH "c" and "cpp"
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    // Only json keeps a rich language worker (pair kept — see header).
    // css/html/ts labels are unreachable now (their rich modes are gone),
    // and everything else always wanted the plain editor worker.
    if (label === "json") return new jsonWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

// Best-effort language guess from a filename, for editor syntax highlighting.
export function languageForFile(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", json5: "json",
    css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", xml: "xml", svg: "xml",
    md: "markdown", markdown: "markdown",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
    sql: "sql", php: "php", lua: "lua", dockerfile: "dockerfile",
  };
  return map[ext] || "plaintext";
}
