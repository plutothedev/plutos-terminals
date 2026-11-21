import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const rl = createInterface({ input: process.stdin });
// --hang-call: read tools/call and never answer (the call-timeout test).
const hangCall = process.argv.includes("--hang-call");
// --exit-on-call: exit without answering when tools/call arrives (a server
// that dies mid-session).
const exitOnCall = process.argv.includes("--exit-on-call");
// --list-changes: the first tools/list says it stays fresh for a minute
// (ttlMs), and every later one lists a different tool (the response-cache test).
const listChanges = process.argv.includes("--list-changes");
// --exit-after-list: answer tools/list, then exit (a server that dies right
// after a listing it answered).
const exitAfterList = process.argv.includes("--exit-after-list");
let lists = 0;
// --pid-file <path>: write this server's pid there once it is up (the
// process-tree tests, which run it behind a `cmd /c` or `sh -c` launcher).
const pidFileAt = process.argv.indexOf("--pid-file");
if (pidFileAt > 0) writeFileSync(process.argv[pidFileAt + 1], String(process.pid));
// --spawn-child <path>: start a long-lived process of its own, the way a tool
// opens a browser or an editor, and write "<server pid> <child pid>" there.
// Detached on Windows only: libuv puts a non-detached child in a kill-on-close
// job of its own, which would end it with this server whatever the app does.
// On unix it stays in the server's process group, the group the app made.
const spawnAt = process.argv.indexOf("--spawn-child");
if (spawnAt > 0) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    detached: process.platform === "win32",
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(process.argv[spawnAt + 1], `${process.pid} ${child.pid}`);
}
// --ignore-eof: keep running after stdin closes (a hung server that the
// app's close does not end), so only a kill ends it.
if (process.argv.includes("--ignore-eof")) setInterval(() => {}, 1 << 30);
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } });
  } else if (msg.method === "notifications/initialized") {
    // no reply
  } else if (msg.method === "tools/list" && listChanges) {
    const first = lists++ === 0;
    send({ jsonrpc: "2.0", id: msg.id, result: {
      tools: [{ name: first ? "echo" : "echo2", inputSchema: { type: "object" } }],
      ...(first ? { ttlMs: 60000, cacheScope: "public" } : {}),
    } });
  } else if (msg.method === "tools/list") {
    const reply = { jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "echoes args", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }
    ] } };
    if (exitAfterList) {
      process.stdout.write(JSON.stringify(reply) + "\n", () => process.exit(0));
    } else {
      send(reply);
    }
  } else if (msg.method === "tools/call") {
    if (hangCall) return;
    if (exitOnCall) process.exit(0);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(msg.params.arguments) }], isError: false } });
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
