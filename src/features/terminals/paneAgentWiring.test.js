// (C)
// TerminalPane's glue to its agent (paneAgent.js), pinned by source: these
// are the lines whose loss no runtime test of the pure modules would notice,
// and mounting the full pane needs a live PTY. Each pin names the behavior.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const NL = String.fromCharCode(10);

const src = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalPane.jsx"), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const a = src.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, to).toBeGreaterThan(-1);
  return src.slice(a, b);
};

describe("TerminalPane's agent wiring", () => {
  it("ignores OSC 7501 replayed from restored scrollback", () => {
    const handler = between("term.parser.registerOscHandler(7501,", "term.parser.registerEscHandler(");
    expect(handler.indexOf("if (restoringScrollback) return true;")).toBeGreaterThan(-1);
    expect(handler.indexOf("if (restoringScrollback) return true;")).toBeLessThan(handler.indexOf("agentOf(ent).report(data)"));
  });

  it("sends xterm's replies to this pane alone, before broadcast, typing or recording", () => {
    const onData = between("term.onData((data) => {", "term.onResize(");
    const reply = onData.indexOf("agentOf(entry).reply(data);");
    expect(onData).toContain("const fromUser = input.take(entry.terminalReplyNext === true);");
    expect(reply).toBeGreaterThan(-1);
    expect(onData.slice(reply, reply + 120)).toContain("return;");
    for (const later of ["entry.counters.userHasTyped = true", "recordInput(", "isBroadcast()"]) {
      expect(onData.indexOf(later), later).toBeGreaterThan(reply);
    }
    expect(src).toContain("const input = watchUserInput(term);");
  });

  it("ends the resume hold only on the user's input", () => {
    const onData = between("term.onData((data) => {", "term.onResize(");
    expect(onData).toContain("if (input.classifies || !FOCUS_REPORTS.includes(data)) agentOf(entry).userInput();");
  });

  it("classifies every onData first, before anything can return early", () => {
    const onData = between("term.onData((data) => {", "term.onResize(");
    expect(onData.slice("term.onData((data) => {".length).trimStart().startsWith("const fromUser = input.take(")).toBe(true);
  });

  it("starts activity tracking on writes made for a person (MultiExec, snippets, agent steps)", () => {
    const writer = between("registerPtyWriter(tabId, (data) => {", "}, visibleRef.current);");
    const start = writer.indexOf("trackerOf(entry).start();");
    expect(start).toBeGreaterThan(writer.indexOf("if (entryLive()) {"));
    expect(start).toBeLessThan(writer.indexOf("entry.writeQueue.write(data);"));
    expect(writer).not.toContain("userInput()");
  });

  it("arms activity tracking on a query, restarts it on output, and starts it on a system prompt", () => {
    const onData = between("term.onData((data) => {", "term.onResize(");
    const reply = onData.indexOf("agentOf(entry).reply(data);");
    expect(onData.slice(reply, onData.indexOf("return;", reply))).toContain("trackerOf(entry).arm();");
    const chunk = between("const handleChunk = ", "const BOOT_MARKER = ");
    const rearm = chunk.indexOf("trackerOf(entry).output();");
    expect(rearm).toBeGreaterThan(-1);
    expect(rearm).toBeLessThan(chunk.indexOf("if (entry.ui.isVisible()) return;"));
    expect(between("entry.writeQueue.write(sysPrompt.trim()", "} catch (err) {")).toContain("trackerOf(entry).start();");
    const tracker = between("const trackerOf = (e) => {", "const appendScrollback = (chunk) => {");
    expect(tracker).toContain("isLive: () => getEntry(paneId) === e,");
    expect(tracker).toContain("isHeld: () => agentOf(e).held,");
    expect(tracker).toContain("isOn: () => e.counters.userHasTyped,");
    expect(tracker).toContain("bytesSinceSeenRef.current = 0; // the startup's bytes are not work" + NL + "        e.counters.userHasTyped = true;");
    expect(tracker).toContain("e.onDestroy.push(() => e.quietTracker?.dispose());");
  });

  it("gives the agent this pane's heuristics, liveness, stores, write queue and phone gate", () => {
    expect(between("const setActivity = (next) => {", "const agentOf = (e) => {")).toContain("e.heuristicActivity = next;");
    const fx = between("const agentOf = (e) => {", "const clearDoneTimer = () => {");
    expect(fx).toContain("isLive: () => getEntry(paneId) === e,");
    expect(fx).toContain('heuristic: () => e.heuristicActivity || "idle",');
    expect(fx).toContain("setPaneDetail(paneId, status);");
    expect(fx).toContain("setPaneActivity(paneId, shown);");
    expect(fx).toContain("if (e.writeQueue) e.writeQueue.write(data);");
    expect(fx).not.toContain('invoke("pty_write"');
    expect(fx).toContain('if (isPrimaryWindow()) invoke("companion_notify_finish", { label, exit, kind })');
  });

  it("sends a mouse report to this pane alone, not as typing, and lets a click answer a dialog", () => {
    const onData = between("term.onData((data) => {", "term.onResize(");
    expect(onData).toContain("const kind = inputKind(data, fromUser);");
    const mouse = onData.indexOf('if (kind === "click" || kind === "mouse") {');
    expect(mouse).toBeGreaterThan(onData.indexOf("agentOf(entry).reply(data);"));
    const branch = onData.slice(mouse, onData.indexOf("return;", mouse));
    expect(branch).toContain("entry.writeQueue.write(data);");
    expect(branch).not.toContain("userInput()");
    expect(branch).not.toContain("userHasTyped");
    expect(branch).not.toContain("Broadcast");
    expect(branch).toContain('if (kind === "click") {' + NL + '              entry.counters.recentOut = "";' + NL + '              if (activityRef.current === "waiting") setActivity("active");' + NL + "            }");
    for (const later of ["agentOf(entry).userInput()", "entry.counters.userHasTyped = true", "recordInput(", "isBroadcast()"]) {
      expect(onData.indexOf(later), later).toBeGreaterThan(mouse);
    }
  });

  it("does not auto-approve a pane held after resuming", () => {
    expect(between("const checkAutoApprove = (ptyId) => {", "const checkCost = () => {")).toContain("if (!agentOf(e).held && (e.ui ? e.ui.isAutoApprove() : autoApproveRef.current))");
  });

  it("resumes without typing the system prompt, and holds the pane", () => {
    expect(src).toContain("if (resumed) agentOf(entry).holdForResume();");
    expect(src).toContain("if (!skipPackCommands && !resumed && sysPrompt");
    expect(src).toContain("entry.writeQueue.write(cmdsToType[i] + \"\\r\");");
  });

  it("acknowledges on reveal, and ends in-flight reports at a prompt and at exit", () => {
    expect(between("resetActivity: prevUi?.resetActivity", "agentSession: () => agentSession")).toContain("if (ent) agentOf(ent).acknowledge();");
    expect(between('if (data === "A" || data.startsWith("A;")) {', "const b = {")).toContain("if (ent) agentOf(ent).endInFlight();");
    expect(between("unlistenExit = await listen(", "// Same late-resolution guard as unlistenData above")).toContain("agentOf(entry).endInFlight();");
  });

  it("feeds the heuristics to the agent, and disposes it with the pane", () => {
    expect(between("const setActivity = (next) => {", "const agentOf = (e) => {")).toContain("agentOf(e).heuristicChanged();");
    expect(between("const agentOf = (e) => {", "const clearDoneTimer = () => {")).toContain("e.onDestroy.push(() => e.agent?.dispose());");
  });
});

describe("the phone's session list", () => {
  const tab = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalsTab.jsx"), "utf8").replace(/\r\n/g, "\n");
  it("sends status changes at most every 250 ms, and stops with the effect", () => {
    const a = tab.indexOf("const push = () => {");
    expect(a).toBeGreaterThan(-1);
    const effect = tab.slice(a, tab.indexOf("}, [sessionListJson]);", a));
    expect(effect).toContain("if (timer === null) timer = setTimeout(push, 250);");
    expect(effect).toContain("const unsubscribe = subscribeActivities(");
    expect(effect).toContain("if (timer !== null) clearTimeout(timer);");
    expect(effect).not.toContain("subscribeActivities(push)");
    expect(effect.startsWith("const push = () => {" + NL + "      timer = null;")).toBe(true);
    expect(effect).toContain("    push();" + NL + "    const unsubscribe = subscribeActivities(");
    expect(effect).toContain("return () => {" + NL + "      unsubscribe();");
  });

  it("carries each pane's shown status", () => {
    expect(tab).toContain("JSON.stringify(list.map((s) => ({ ...s, status: getPaneActivity(s.tabId) })))");
  });
});

describe("pane labels", () => {
  it("names a split pane in notices the way session lists do", () => {
    const panel = readFileSync(path.join(process.cwd(), "src/features/terminals/TerminalPanel.jsx"), "utf8");
    expect(panel).toContain("paneLabel={paneSessionLabel(tab, node.id, leafIds(getLayout(tab)).indexOf(node.id), leafIds(getLayout(tab)).length)}");
  });
});

describe("TerminalPane's phone input", () => {
  const listener = () => between("unlistenPhone = await listen(`companion-input://$" + "{id}`, (e) => {", "registerDestroyHook(tabId, () => {");
  it("drops a matched dialog and ends waiting when the phone answers", () => {
    const l = listener();
    expect(l).toContain("const fx = phoneInputEffect(e.payload);");
    expect(l).toContain("if (fx.answers) {" + NL + "            entry.counters.recentOut = \"\";" + NL + "            if (activityRef.current === \"waiting\") setActivity(\"active\");");
  });
  it("turns tracking on for the phone's typing and its own writes, and never ends the resume hold", () => {
    const l = listener();
    expect(l).toContain("if (fx.typed) entry.counters.userHasTyped = true;");
    expect(l).toContain("if (fx.started) trackerOf(entry).start();");
    // `typed` is the phone's own word, so it cannot lift the hold.
    expect(l).not.toContain("userInput(");
    expect(l).not.toContain("held");
    // It never writes, broadcasts or records: the phone already wrote.
    for (const never of ["writeQueue", "writeBroadcast", "recordInput", "pty_write"]) expect(l).not.toContain(never);
  });
  it("detaches with the pane, and at once if the pane died while it attached", () => {
    const l = listener();
    expect(l).toContain("if (!entryLive()) { detach(unlistenData); detach(unlistenExit); detach(unlistenPhone); return; }");
    expect(src).toContain("const detach = (unlisten) => { try { unlisten?.(); } catch { /* already detached */ } };");
    const hook = between("registerDestroyHook(tabId, () => {" + NL + "          try { unlistenData(); } catch {}", "});");
    expect(hook).toContain("detach(unlistenPhone);");
  });
});

// The phone page is a plain script that boots a socket on load, so its few
// load-bearing lines are pinned here by source too.
describe("the phone page", () => {
  const app = readFileSync(path.join(process.cwd(), "src-tauri/companion-web/app.js"), "utf8").replace(/\r\n/g, "\n");
  it("sends only the user's own input when xterm can tell, and clears the mark every time", () => {
    expect(app).toContain("if (typeof userSignal === \"function\") userSignal(() => { userNext = true; });");
    expect(app).toContain("const fromUser = classifies ? userNext : true;\n    userNext = false;");
    expect(app).toContain("if (currentId && fromUser && (classifies || !replaying)) rpc(\"pty_write\", { id: currentId, data: d, typed: true });");
  });
  it("drops a history load another session overtook, and only its own write ends the replay", () => {
    const open = app.slice(app.indexOf("async function openSession(s) {"));
    const load = open.indexOf("await rpc(\"scrollback_load\"");
    const stale = open.indexOf("if (gen !== replayGen) return;");
    expect(stale).toBeGreaterThan(load);
    expect(stale).toBeLessThan(open.indexOf("replaying = true;"));
    expect(open).toContain("term.write(sb, () => { if (gen === replayGen) replaying = false; });");
  });
  it("re-reads the desktop's statuses every 15 s while showing, for sessions it already has", () => {
    const refresh = app.slice(app.indexOf("async function refreshStatuses() {"), app.indexOf("async function loadSessions() {"));
    expect(refresh).toContain('if (document.visibilityState !== "visible" || !socketReady || !ws || ws.readyState !== 1) return;');
    expect(app).toContain("readyThisConn = true; socketReady = true;");
    expect(app).toContain("ws.onclose = () => {" + NL + "    socketReady = false;");
    expect(refresh).toContain("const since = Date.now() - 3000;" + NL + "  let list;" + NL + '  try { list = await rpc("list_sessions"); }');
    expect(refresh).toContain("if (s && sstate[s.id] && !((sstate[s.id].reportedAt || 0) >= since)) seedStatus(s);");
    expect(app).toContain("st.agent = next;" + NL + "    st.reportedAt = Date.now();");
    // waiting, active and done map to the phone's own states; idle clears.
    expect(app).toContain('const STATUS_AS_AGENT = { waiting: "blocked", active: "working", done: "done" };');
    expect(app).toContain('else if (s.status === "idle") sstate[s.id].agent = null;');
    expect(refresh).toContain("setInterval(refreshStatuses, STATUS_REFRESH_MS);");
    expect(app).toContain("const STATUS_REFRESH_MS = 15000;");
    expect(app).toContain("function ensureSubscriptions() {\n  for (const s of sessions) {\n    seedStatus(s);");
  });

  it("ends an agent's in-flight state at a later shell prompt, keeping done and error", () => {
    expect(app).toContain('if (promptAt > reportAt && st.agent && st.agent !== "done" && st.agent !== "error") { st.agent = null; st.reportedAt = Date.now(); }');
  });
});
