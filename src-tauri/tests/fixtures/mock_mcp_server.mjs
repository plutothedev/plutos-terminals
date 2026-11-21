import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
// --hang-call: read tools/call and never answer (the call-timeout test).
const hangCall = process.argv.includes("--hang-call");
// --exit-on-call: exit without answering when tools/call arrives (a server
// that dies mid-session).
const exitOnCall = process.argv.includes("--exit-on-call");
// --list-changes: the first tools/list says it stays fresh for a minute
// (ttlMs), and every later one lists a different tool (the response-cache test).
const listChanges = process.argv.includes("--list-changes");
let lists = 0;
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
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "echoes args", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }
    ] } });
  } else if (msg.method === "tools/call") {
    if (hangCall) return;
    if (exitOnCall) process.exit(0);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(msg.params.arguments) }], isError: false } });
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
