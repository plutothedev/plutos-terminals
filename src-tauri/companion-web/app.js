// (C) Pluto's Terminal — phone/web companion app logic.
// Externalized from index.html's inline <script> so the page can run under a
// strict CSP (script-src 'self'; no 'unsafe-inline', no CDN). Loaded as a classic
// script AFTER /vendor/xterm.js and /vendor/addon-fit.js, which expose the UMD
// globals `Terminal` and `FitAddon` (namespace: `new FitAddon.FitAddon()`).
const $ = (id) => document.getElementById(id);
const status = (t, cls) => { const s = $("status"); s.textContent = t; s.className = cls || ""; };

let ws, rpcId = 0, pending = {}, subs = {}, currentId = null, currentTab = null;
let term, fit;
let sessions = [];              // [{id, tabId, label, active}] from the desktop
const sstate = {};              // id -> { dirty, running, exit } activity tracking
const tabEls = {};              // id -> tab <span>, for in-place badge updates

function rpc(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId; pending[id] = { resolve, reject };
    ws.send(JSON.stringify({ type: "rpc", id, cmd, args: args || {} }));
  });
}
function subscribe(channel, cb) { subs[channel] = cb; ws.send(JSON.stringify({ type: "subscribe", channel })); }

function initTerm() {
  term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "Menlo, Monaco, monospace",
    theme: { background: "#0b0d0f", foreground: "#cfd6dd" }, scrollback: 5000 });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open($("term")); fit.fit();
  term.onData((d) => { if (currentId) rpc("pty_write", { id: currentId, data: d }); });
  window.addEventListener("resize", () => { try { fit.fit(); sendResize(); } catch {} });
}
function sendResize() { if (currentId && term) rpc("pty_resize", { id: currentId, cols: term.cols, rows: term.rows }).catch(() => {}); }

// ── Per-session activity via OSC 133 (shell-integration) markers ───────────
// 133;C = a command started running; 133;D[;exit] = it finished. Each session
// is subscribed even while backgrounded, so a long build/test on another tab
// badges that tab and fires a notification the moment it completes.
const OSC133 = /\x1b\]133;([A-D])(?:;(\d+))?/g;
function scanActivity(s, payload) {
  const st = sstate[s.id];
  let m, finished = false, exit = 0;
  while ((m = OSC133.exec(payload))) {
    if (m[1] === "C") st.running = true;
    else if (m[1] === "D") { if (st.running) { finished = true; exit = m[2] != null ? +m[2] : 0; } st.running = false; st.exit = m[2] != null ? +m[2] : 0; }
  }
  if (s.id !== currentId) { st.dirty = true; if (finished) notifyDone(s, exit); }
  updateBadge(s.id);
}
function notifyDone(s, exit) {
  const title = (exit === 0 ? "✓ " : "✗ ") + (s.label || "session") + " finished" + (exit ? ` (exit ${exit})` : "");
  try { if (window.Notification && Notification.permission === "granted") new Notification(title, { tag: "pt-" + s.id, body: "Tap to view in Pluto Remote" }); } catch {}
}
function badgeFor(id) {
  const st = sstate[id] || {};
  if (st.running) return { t: "•", c: "#E0A04F" };               // running (amber)
  if (st.exit) return { t: "✗", c: "#E05B5B" };                  // last command failed
  if (st.dirty) return { t: "•", c: "var(--cy)" };               // unseen output
  return null;
}
function updateBadge(id) {
  const el = tabEls[id]; if (!el) return;
  const b = el.querySelector(".badge"); const info = badgeFor(id);
  if (b) { if (info) { b.textContent = info.t; b.style.color = info.c; b.style.display = ""; } else b.style.display = "none"; }
}

// A session is { id, tabId, label, active }: `id` is the live pty channel id
// (subscribe + write/resize); `tabId` is the scrollback key (history load).
async function openSession(s) {
  if (!s || !s.id) return;
  currentId = s.id; currentTab = s.tabId || s.id;
  if (sstate[s.id]) { sstate[s.id].dirty = false; sstate[s.id].exit = 0; }
  term.reset();
  try { const sb = await rpc("scrollback_load", { tabId: currentTab }); if (sb) term.write(sb); } catch {}
  try { fit.fit(); } catch {}
  sendResize();
  for (const id in tabEls) tabEls[id].classList.toggle("active", id === s.id);
  updateBadge(s.id);
}

function renderTabs() {
  const c = $("tabs"); c.innerHTML = ""; for (const k in tabEls) delete tabEls[k];
  for (const s of sessions) {
    const el = document.createElement("span");
    el.className = "tab" + (s.id === currentId ? " active" : "");
    el.dataset.id = s.id;
    const name = document.createElement("span"); name.textContent = s.label || "shell";
    const badge = document.createElement("span"); badge.className = "badge"; badge.style.display = "none";
    el.append(name, badge);
    el.onclick = () => openSession(s);
    c.appendChild(el); tabEls[s.id] = el;
    if (!sstate[s.id]) sstate[s.id] = { dirty: false, running: false, exit: 0 };
    updateBadge(s.id);
  }
}

// Subscribe to EVERY session so backgrounded ones still badge + notify; only
// the current one is painted into the terminal. Idempotent — skips channels
// already subscribed (so a refresh only arms the new sessions).
function ensureSubscriptions() {
  for (const s of sessions) {
    if (subs["pty://" + s.id]) continue;
    if (!sstate[s.id]) sstate[s.id] = { dirty: false, running: false, exit: 0 };
    subscribe("pty://" + s.id, (payload) => { if (s.id === currentId) term.write(payload); scanActivity(s, payload); });
  }
}
async function loadSessions() {
  let list = []; try { list = (await rpc("list_sessions")) || []; } catch {}
  sessions = Array.isArray(list) ? list : [];
  renderTabs(); ensureSubscriptions();
  return sessions;
}

async function onReady() {
  status("connected", "ok");
  // Learn the desktop shell so "cd here" quotes correctly (PowerShell vs POSIX).
  try { const sh = await rpc("default_shell"); shellKind = /powershell|pwsh/i.test(sh) ? "pwsh" : /cmd(\.exe)?$/i.test(sh) ? "cmd" : "posix"; } catch {}
  registerPush(); // Phase 5: subscribe for push-when-closed (HTTPS only)
  try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch {}
  await loadSessions();
  if (!sessions.length) { status("no sessions on desktop", "err"); return; }
  // Keep the phone's current view across reconnects when still valid.
  const keep = sessions.find((s) => s.id === currentId);
  openSession(keep || sessions.find((s) => s.active) || sessions[0]);
}

// Ask the desktop to open a new shell, then poll the list until it appears
// (the desktop spawns the PTY + re-pushes the list asynchronously).
async function newSession() {
  const before = new Set(sessions.map((s) => s.id));
  status("opening new shell…");
  try { await rpc("new_session", { kind: "local" }); } catch { status("connected", "ok"); return; }
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    await loadSessions();
    const fresh = sessions.find((s) => !before.has(s.id));
    if (fresh) { status("connected", "ok"); openSession(fresh); return; }
  }
  status("connected", "ok");
}

// ── Web Push (Phase 5) ──────────────────────────────────────────────────────
// Over HTTPS (Tailscale Serve fronts TLS), register the service worker and
// subscribe so the desktop can ping this phone when a command finishes with the
// tab closed. Best-effort: needs a secure context + the user granting permission.
function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function registerPush() {
  try {
    if (location.protocol !== "https:") return;           // push needs a secure context
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = await navigator.serviceWorker.register("/sw.js");
    if (window.Notification && Notification.permission === "default") await Notification.requestPermission();
    if (!window.Notification || Notification.permission !== "granted") return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const pubKey = await rpc("vapid_public_key");
      if (!pubKey) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(pubKey) });
    }
    await rpc("push_subscribe", { subscription: sub.toJSON() });
    status("push on", "ok");
  } catch { /* push is best-effort */ }
}

let backoff = 1000, failsBeforeReady = 0;
function connect(token) {
  let readyThisConn = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(token);
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "ready") { readyThisConn = true; backoff = 1000; failsBeforeReady = 0;
      $("login").classList.add("hidden"); $("app").classList.remove("hidden");
      if (!term) initTerm(); setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 50); onReady(); }
    else if (m.type === "rpc-result") { const p = pending[m.id]; if (p) { delete pending[m.id]; ("err" in m) ? p.reject(m.err) : p.resolve(m.ok); } }
    else if (m.type === "event") { const cb = subs[m.channel]; if (cb) cb(m.payload); }
  };
  ws.onclose = () => {
    subs = {};
    // A close BEFORE "ready" means auth failed — usually a stale token after the
    // server restarted (restart mints a fresh one). Back off, and after a few
    // such failures stop and re-show the login gate so the new token can be
    // entered, instead of hammering the just-restarted server every 1.5s forever.
    if (!readyThisConn && ++failsBeforeReady >= 3) {
      try { localStorage.removeItem("pt_token"); } catch {}
      $("app").classList.add("hidden"); $("files").classList.add("hidden");
      $("login").classList.remove("hidden");
      $("loginerr").textContent = "Token rejected — enter the current token from your desktop.";
      return;
    }
    const delay = readyThisConn ? 1500 : backoff;
    if (!readyThisConn) backoff = Math.min(backoff * 2, 15000);
    status("disconnected — reconnecting…", "err");
    setTimeout(() => connect(token), delay);
  };
  ws.onerror = () => {};
}

// ── File browser (Phase 4) ─────────────────────────────────────────────────
// Read-only browse of the desktop's local filesystem; "cd here" sends a cd into
// the active session. list_directory returns [resolvedPath, [{name,path,is_dir,size}]].
let filesPath = null;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const human = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB");
// Shell-aware quoting for "cd here". Set from default_shell on connect: the
// desktop is usually PowerShell on Windows, which escapes a single quote by
// DOUBLING it ('') — the POSIX '\'' idiom would mis-parse and leave stray text.
let shellKind = "posix";
const shq = (s) => {
  s = String(s);
  if (shellKind === "pwsh") return "'" + s.replace(/'/g, "''") + "'";   // PowerShell
  if (shellKind === "cmd") return '"' + s.replace(/"/g, "") + '"';       // cmd.exe (no quote-escape)
  return "'" + s.replace(/'/g, "'\\''") + "'";                          // sh / bash / zsh
};
const parentPath = (p) => { const q = p.replace(/\/+$/, ""); const i = q.lastIndexOf("/"); return i > 0 ? q.slice(0, i) : "/"; };
async function openFiles(path) {
  try {
    const res = await rpc("list_directory", { path: path || null });
    const resolved = res[0], entries = res[1] || [];
    filesPath = resolved; $("filespath").textContent = resolved;
    const c = $("fileslist"); c.innerHTML = "";
    for (const it of entries) {
      const row = document.createElement("div"); row.className = "frow";
      row.innerHTML = `<span class="ficon">${it.is_dir ? "📁" : "📄"}</span><span class="fname">${esc(it.name)}</span><span class="fsize">${it.is_dir ? "" : human(it.size)}</span>`;
      if (it.is_dir) row.onclick = () => openFiles(it.path);
      c.appendChild(row);
    }
    $("files").classList.remove("hidden");
  } catch (e) { status("files: " + e, "err"); }
}
$("filesbtn").onclick = () => { if (ws && ws.readyState === 1) openFiles(filesPath || null); };
$("filesup").onclick = () => filesPath && openFiles(parentPath(filesPath));
$("filesclose").onclick = () => $("files").classList.add("hidden");
$("filescd").onclick = () => {
  if (filesPath && currentId) {
    const p = filesPath.replace(/^\\\\\?\\/, ""); // strip Windows \\?\ verbatim prefix so `cd` accepts it
    rpc("pty_write", { id: currentId, data: `cd ${shq(p)}\r` });
    $("files").classList.add("hidden");
  }
};

// ── Snippets (Phase 4) ──────────────────────────────────────────────────────
// Saved commands pushed from the desktop (st.snippets). Tap to INSERT a command
// into the active session — no auto-run (matches the desktop's "click to insert":
// review, then press Enter). {{vars}} open an inline fill form first.
let snippets = [];
const VARRE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const snipVars = (cmd) => { const out = []; let m; VARRE.lastIndex = 0; while ((m = VARRE.exec(cmd || ""))) if (!out.includes(m[1])) out.push(m[1]); return out; };
const fillVars = (cmd, vals) => String(cmd || "").replace(VARRE, (_, n) => (vals[n] != null && vals[n] !== "" ? vals[n] : `{{${n}}}`));
function insertSnippet(cmd) { if (currentId && cmd) rpc("pty_write", { id: currentId, data: cmd }); $("snippets").classList.add("hidden"); }
function renderSnippets() {
  const c = $("sniplist"); c.innerHTML = "";
  if (!snippets.length) { c.innerHTML = `<div class="srow" style="cursor:default"><div class="sname" style="color:var(--dim)">No snippets on the desktop.</div></div>`; return; }
  for (const s of snippets) {
    const row = document.createElement("div"); row.className = "srow";
    row.innerHTML = `<div class="sname">${esc(s.name || s.command || "")}</div><div class="scmd">${esc(s.command || "")}</div>`;
    row.onclick = () => pickSnippet(s);
    c.appendChild(row);
  }
}
function pickSnippet(s) {
  const vars = snipVars(s.command);
  if (!vars.length) { insertSnippet(s.command); return; }
  const c = $("sniplist"); c.innerHTML = "";
  const form = document.createElement("div"); form.className = "sfill";
  const vals = {};
  const preview = document.createElement("div"); preview.className = "scmd"; preview.textContent = s.command;
  const inputs = vars.map((v) => {
    const i = document.createElement("input"); i.placeholder = v; i.autocapitalize = "off"; i.autocomplete = "off"; i.spellcheck = false;
    i.oninput = () => { vals[v] = i.value; preview.textContent = fillVars(s.command, vals); };
    return i;
  });
  const bar = document.createElement("div"); bar.className = "sfrow";
  const cancel = document.createElement("button"); cancel.textContent = "cancel"; cancel.onclick = renderSnippets;
  const go = document.createElement("button"); go.className = "go"; go.textContent = "insert"; go.onclick = () => insertSnippet(fillVars(s.command, vals));
  bar.append(cancel, go);
  form.append(...inputs, preview, bar);
  c.appendChild(form);
  if (inputs[0]) inputs[0].focus();
}
async function openSnippets() {
  try { snippets = (await rpc("list_snippets")) || []; } catch { snippets = []; }
  if (!Array.isArray(snippets)) snippets = [];
  renderSnippets(); $("snippets").classList.remove("hidden");
}
$("snipbtn").onclick = () => { if (ws && ws.readyState === 1) openSnippets(); };
$("snipclose").onclick = () => $("snippets").classList.add("hidden");

// ── Model picker (Phase 4) ──────────────────────────────────────────────────
// Catalog + active model pushed from the desktop. Only providers with a key
// configured carry hasKey:true — API keys NEVER leave the desktop. Picking a
// model sets it active for the NEXT shell spawned on the desktop (same as the
// desktop picker: env vars inject at spawn, so `claude`/`codex` route to it).
let models = { active: null, providers: [] };
function renderModels() {
  const c = $("modellist"); c.innerHTML = "";
  const active = models.active || {};
  const usable = (models.providers || []).filter((p) => p.hasKey && (p.models || []).length);
  if (!usable.length) {
    c.innerHTML = `<div class="srow" style="cursor:default"><div class="sname" style="color:var(--dim)">No models configured. Add a provider key in the desktop Models picker.</div></div>`;
    return;
  }
  for (const p of usable) {
    const g = document.createElement("div"); g.className = "mgroup"; g.textContent = p.label || p.id; c.appendChild(g);
    for (const m of p.models) {
      const on = active.providerId === p.id && active.model === m;
      const row = document.createElement("div"); row.className = "mrow" + (on ? " active" : "");
      row.innerHTML = `<span class="mcheck">${on ? "✓" : ""}</span><span class="mname">${esc(m)}</span>`;
      row.onclick = () => selectModel(p.id, m);
      c.appendChild(row);
    }
  }
}
async function selectModel(providerId, model) {
  try { await rpc("set_active_model", { providerId, model }); } catch {}
  models.active = { providerId, model };
  renderModels();
  status("model → " + model, "ok");
  // Re-pull once the desktop has validated + re-pushed (it may reject an
  // unconfigured provider, in which case the active stays as the desktop sees it).
  setTimeout(() => { loadModels().then(renderModels).catch(() => {}); }, 500);
}
async function loadModels() {
  let v = null; try { v = await rpc("list_models"); } catch {}
  models = v && typeof v === "object" ? v : { active: null, providers: [] };
  if (!Array.isArray(models.providers)) models.providers = [];
  return models;
}
async function openModels() { await loadModels(); renderModels(); $("models").classList.remove("hidden"); }
$("modelbtn").onclick = () => { if (ws && ws.readyState === 1) openModels(); };
$("modelclose").onclick = () => $("models").classList.add("hidden");

$("newbtn").onclick = () => { if (ws && ws.readyState === 1) newSession(); };
$("connect").onclick = () => { const t = $("token").value.trim(); if (t) { failsBeforeReady = 0; backoff = 1000; $("loginerr").textContent = ""; localStorage.setItem("pt_token", t); connect(t); } };
$("token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("connect").click(); });

// Auto-connect if a token is in the URL hash (#<token>) or remembered.
const hashToken = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
const saved = localStorage.getItem("pt_token");
if (hashToken) { $("token").value = hashToken; localStorage.setItem("pt_token", hashToken); connect(hashToken); }
else if (saved) { $("token").value = saved; connect(saved); }
