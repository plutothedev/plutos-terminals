// (C)
// Headless smoke of the PACKAGED app (the release exe, not `npm run dev`), for
// the class of bug the dev loop cannot see: Tauri's CSP processing, the
// packaged asset pipeline, the real PTY path. Drives the WebView2 webview over
// the Chrome DevTools Protocol, which WebView2 exposes when the process is
// started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port.
//
//   npm run tauri build -- --bundles msi
//   node scripts/smoke-packaged.mjs [--exe path] [--port 9229] [--out dir]
//
// What it proves, in order: the window boots and mounts a terminal; the xterm
// stylesheet is present and the helper textarea is monospace (the CSP trap of
// 2026-08-14 shows up here as font-family: system-ui on terminal elements);
// typing a marker command into the first terminal reaches the shell and its
// echo lands in the persisted scrollback (the canvas renderer keeps the DOM
// rows empty, so the disk copy is the readback); zero console/log errors; and
// a PNG screenshot for a human to look at. Exit 0 only when all of that held.
//
// CAVEATS. It runs against the user's REAL profile (%LOCALAPPDATA%/com.plutothedev.terminals),
// so saved sessions spawn and the boot migrations run; back that folder up
// first if the build under test touches persistence. Nothing else should be
// listening on the chosen port. The exe is killed at the end, tree and all.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const exe = resolve(arg("--exe", "src-tauri/target/release/plutos-terminals.exe"));
const port = arg("--port", "9229");
const out = resolve(arg("--out", "."));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!existsSync(exe)) { console.error("no exe at", exe); process.exit(9); }
const child = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: "ignore",
  detached: false,
});
log("spawned", exe, "pid", child.pid);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.events = []; }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; this.ws.onmessage = (m) => this.onmsg(JSON.parse(m.data)); }); }
  onmsg(m) {
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    else if (m.method) this.events.push(m);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}

let verdict = { ok: false };
try {
  let pages = [];
  for (let i = 0; i < 60 && !pages.length; i++) {
    try { pages = (await targets()).filter((t) => t.type === "page"); } catch { /* not listening yet */ }
    if (!pages.length) await sleep(1000);
  }
  if (!pages.length) throw new Error("no page target on the debugging port after 60 s");
  const main = pages.find((p) => !/\?w=/.test(p.url)) || pages[0];
  const c = new CDP(main.webSocketDebuggerUrl);
  await c.open();
  await c.send("Runtime.enable"); await c.send("Log.enable"); await c.send("Page.enable");
  log("connected:", main.url);

  let xterms = 0;
  for (let i = 0; i < 60 && !xterms; i++) { xterms = await c.eval("document.querySelectorAll('.xterm').length"); if (!xterms) await sleep(1000); }
  const title = await c.eval("document.title");
  const sheets = await c.eval("[...document.styleSheets].filter(s=>{try{return [...s.cssRules].some(r=>(r.selectorText||'').includes('.xterm'))}catch(e){return false}}).length");
  const helperFont = await c.eval("(()=>{const el=document.querySelector('.xterm-helper-textarea');return el?getComputedStyle(el).fontFamily:null})()");
  const canvases = await c.eval("document.querySelectorAll('.xterm canvas').length");
  log("title:", title, "| xterms:", xterms, "| xterm stylesheets:", sheets, "| helper font:", helperFont, "| canvases:", canvases);

  await sleep(4000);
  const focused = await c.eval("(()=>{const t=document.querySelector('.xterm-helper-textarea');if(!t)return false;t.focus();return document.activeElement===t})()");
  const marker = "SMOKE_OK_" + Date.now().toString(36).toUpperCase();
  await c.send("Input.insertText", { text: `echo ${marker}` });
  await sleep(300);
  for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(3500);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const png = join(out, "smoke-packaged.png");
  if (shot.result?.data) writeFileSync(png, Buffer.from(shot.result.data, "base64"));

  const errs = c.events.filter((e) =>
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "error"));
  for (const e of errs.slice(0, 10)) log("  ERROR:", JSON.stringify(e.params).slice(0, 300));

  // Readback from disk: the reader thread persists scrollback per tab.
  const sbDir = join(process.env.LOCALAPPDATA || "", "com.plutothedev.terminals", "terminals", "scrollback");
  let echoed = false;
  if (existsSync(sbDir)) {
    for (const f of readdirSync(sbDir)) {
      try { if (readFileSync(join(sbDir, f), "utf8").includes(marker)) { echoed = true; break; } } catch { /* a file mid-rotation; skip it */ }
    }
  }
  const systemUi = /system-ui/i.test(helperFont || "");
  verdict = { ok: xterms > 0 && errs.length === 0 && echoed && sheets > 0 && !systemUi, xterms, sheets, helperFont, canvases, focused, marker, echoed, errors: errs.length, title, screenshot: png };
  c.ws.close();
} catch (e) {
  verdict = { ok: false, error: String(e) };
} finally {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
}
console.log(JSON.stringify(verdict));
log(verdict.ok ? "SMOKE OK" : "SMOKE FAILED");
process.exitCode = verdict.ok ? 0 : 1;
