// (C)
// Configure @monaco-editor/react to use the BUNDLED monaco-editor (never the
// CDN — this is an offline desktop app) and wire its web workers through Vite's
// ?worker imports so language features work inside Tauri's webview. Imported
// once for its side effects before any <Editor> mounts.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
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
