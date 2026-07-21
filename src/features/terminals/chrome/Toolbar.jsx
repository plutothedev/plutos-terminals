// (C)
import { useMemo } from "react";
import {
  SLocal, SSsh, SSerial, SSplit, SSplitRow, SSplitCol, SMultiX, STunnel, SAsk, SModels, SSnips, SAgents, SSearch,
} from "../toolbarIcons.jsx";
import MobaToolbar from "../MobaToolbar";

export default function Toolbar({
  activeTabId, activeTab, splitPane, broadcast, toggleBroadcast,
  tunnelsOpen, setTunnelsOpen, openTunnels, ribbon, selectRibbon,
  setDialog, setSerialOpen, setAskOpen, setAgentOpen, setModelsOpen,
  totalCost, quickConnect,
}) {
  const toolbarGroups = useMemo(() => [
    {
      caption: "Connect",
      items: [
        { id: "local", icon: <SLocal />, label: "Local", title: "New local shell session", onClick: () => setDialog({ mode: "add" }) },
        { id: "ssh", icon: <SSsh />, label: "SSH", title: "New SSH / server session", onClick: () => setDialog({ mode: "add", initialType: "ssh" }) },
        { id: "serial", icon: <SSerial />, label: "Serial", title: "Serial console session", onClick: () => setSerialOpen(true) },
      ],
    },
    {
      caption: "Workspace",
      items: [
        { id: "split", icon: <SSplit />, label: "Split", title: "Split the active pane", disabled: !activeTabId, menu: [
          { id: "split-row", icon: <SSplitRow size={15} />, label: "Side by side", onClick: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "row") },
          { id: "split-col", icon: <SSplitCol size={15} />, label: "Stacked", onClick: () => activeTabId && splitPane(activeTabId, activeTab?.activePaneId || activeTabId, "col") },
        ] },
        { id: "multiexec", icon: <SMultiX />, label: "MultiX", title: "Broadcast typing to every visible terminal at once", active: broadcast, onClick: toggleBroadcast },
        { id: "tunnel", icon: <STunnel />, label: "Tunnel", title: activeTab?.connection ? "SSH port forwarding (tunnels) for the active SSH session" : "Open an SSH session to forward ports", active: tunnelsOpen, disabled: !tunnelsOpen && !activeTab?.connection, onClick: () => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels()) },
      ],
    },
    {
      caption: "AI · Tools",
      items: [
        { id: "ask", icon: <SAsk />, label: "Ask AI", title: "Ask AI to turn plain English into a shell command (Ctrl+I)", onClick: () => setAskOpen(true) },
        { id: "agent", icon: <SAgents />, label: "Agent", title: "Agent Mode — give a goal in plain English; it runs commands to do it (Ctrl+Shift+A)", onClick: () => setAgentOpen(true) },
        { id: "models", icon: <SModels />, label: "Models", title: "Pick your LLM provider + model and enter its API key", onClick: () => setModelsOpen(true) },
        { id: "snips", icon: <SSnips />, label: "Workflows", title: "Workflows — saved parameterized commands; click to run", active: ribbon === "snippets", onClick: () => selectRibbon(ribbon === "snippets" ? null : "snippets") },
        { id: "agents", icon: <SAgents />, label: "Agents", title: "Agent mission control", active: ribbon === "agents", onClick: () => selectRibbon(ribbon === "agents" ? null : "agents") },
      ],
    },
  ], [
    activeTabId, activeTab, splitPane, broadcast, toggleBroadcast,
    tunnelsOpen, setTunnelsOpen, openTunnels, ribbon, selectRibbon,
  ]);

  return (
    <MobaToolbar
      right={
        <>
          {(totalCost.cost > 0 || totalCost.tokens > 0) && (
            <span className="phn-cost" title="Live aggregate from Claude /cost output across all sessions">
              ${totalCost.cost.toFixed(2)}
              {totalCost.tokens > 0 && ` · ${totalCost.tokens >= 1000 ? `${(totalCost.tokens / 1000).toFixed(1)}k` : totalCost.tokens} tok`}
            </span>
          )}
          <div className="moba-qc-inline" title="Quick connect — user@host (Enter)">
            <SSearch size={13} />
            <input
              placeholder="quick connect — user@host"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") { quickConnect(e.currentTarget.value); e.currentTarget.value = ""; } }}
            />
          </div>
        </>
      }
      groups={toolbarGroups}
    />
  );
}
