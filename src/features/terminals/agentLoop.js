// (C)
// Native-tool-calling ReAct loop for the in-app agent. All side effects are
// injected (toolTurn / executeTool / requestApproval / needsApproval / onStep) so
// the loop is unit-testable with fakes. The loop maintains the normalized message
// list, gates each tool call, executes approved calls, and feeds results back
// until the model stops calling tools (stop_reason "end") or the step cap / stop.
import { humanizeError } from "./errorText.js";

export async function runAgentLoop({
  goal, toolTurn, executeTool, requestApproval, needsApproval,
  onStep, maxSteps = 14, shouldStop = () => false,
}) {
  const messages = [{ role: "user", text: `GOAL: ${goal}` }];
  for (let i = 0; i < maxSteps; i++) {
    if (shouldStop()) { onStep({ type: "done", text: "Stopped by you." }); return; }
    let res;
    try { res = await toolTurn(messages); }
    catch (e) { onStep({ type: "error", text: humanizeError(e).message }); return; }
    if (shouldStop()) { onStep({ type: "done", text: "Stopped by you." }); return; }

    const calls = res.tool_calls || [];
    if (res.text) onStep({ type: "text", text: res.text });
    if (!calls.length || res.stop_reason === "end") {
      onStep({ type: "done", text: res.text || "Done." });
      return;
    }
    messages.push({ role: "assistant", text: res.text || "", tool_calls: calls });

    for (const call of calls) {
      if (shouldStop()) { onStep({ type: "done", text: "Stopped by you." }); return; }
      let args = call.args || {};
      if (needsApproval(call)) {
        const d = await requestApproval(call);
        if (d.action === "stop") { onStep({ type: "done", text: "Stopped by you." }); return; }
        if (d.action === "skip") {
          onStep({ type: "skip", call });
          messages.push({ role: "tool", tool_call_id: call.id, content: "(skipped by the user)", is_error: false });
          continue;
        }
        if (d.args) args = d.args;
      }
      const finalCall = { ...call, args };
      onStep({ type: "call", call: finalCall });
      let result;
      try { result = await executeTool(finalCall); }
      catch (e) { result = { content: String(e), isError: true }; }
      onStep({ type: "result", id: call.id, content: result.content, isError: !!result.isError });
      messages.push({ role: "tool", tool_call_id: call.id, content: String(result.content ?? ""), is_error: !!result.isError });
    }
    if (i === maxSteps - 1) onStep({ type: "done", text: "Reached the step limit." });
  }
}
