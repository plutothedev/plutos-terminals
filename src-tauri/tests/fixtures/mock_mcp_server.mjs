import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } });
  } else if (msg.method === "notifications/initialized") {
    // no reply
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "echoes args", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }
    ] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(msg.params.arguments) }], isError: false } });
  } else if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
