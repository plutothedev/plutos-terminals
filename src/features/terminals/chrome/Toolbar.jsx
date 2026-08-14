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
        { id: "local", icon: <SLocal />, label: "Local", title: "Add a local session (folder + start commands)", onClick: () => setDialog({ mode: "add" }) },
        { id: "ssh", icon: <SSsh />, label: "SSH", title: "Add an SSH session", onClick: () => setDialog({ mode: "add", initialType: "ssh" }) },
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
        { id: "multiexec", icon: <SMultiX />, label: "Broadcast", title: "Broadcast typing to every visible terminal at once", active: broadcast, onClick: toggleBroadcast },
        { id: "tunnel", icon: <STunnel />, label: "Tunnel", title: activeTab?.connection ? "Port forwarding (SSH tunnels) for the active SSH session" : "Port forwarding — open an SSH session first", active: tunnelsOpen, disabled: !tunnelsOpen && !activeTab?.connection, onClick: () => (tunnelsOpen ? setTunnelsOpen(false) : openTunnels()) },
      ],
    },
    {
      caption: "AI · Tools",
      items: [
        { id: "ask", icon: <SAsk />, label: "Ask AI", title: "Ask AI to turn plain English into a shell command (Ctrl+I)", onClick: () => setAskOpen(true) },
        { id: "agent", icon: <SAgents />, label: "Agent Mode", title: "Agent Mode — give a goal in plain English; it runs commands to do it (Ctrl+Shift+A)", onClick: () => setAgentOpen(true) },
        { id: "models", icon: <SModels />, label: "Models", title: "Pick your LLM provider + model and enter its API key", onClick: () => setModelsOpen(true) },
        { id: "snips", icon: <SSnips />, label: "Workflows", title: "Workflows — saved parameterized commands; click to run", active: ribbon === "snippets", onClick: () => selectRibbon(ribbon === "snippets" ? null : "snippets") },
        { id: "agents", icon: <SAgents />, label: "Fleet", title: "Fleet — agent mission control: every running agent, needs-you flags, one panel", active: ribbon === "agents", onClick: () => selectRibbon(ribbon === "agents" ? null : "agents") },
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
          <div className="moba-qc-inline" data-tour="quick-connect" title="Quick connect — opens an SSH session to what you type (Enter)">
            <SSearch size={13} />
            <input
              placeholder="user@server or 192.168.1.10"
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
