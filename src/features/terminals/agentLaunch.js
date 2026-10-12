// (C)
// Claude Code conversations that survive an app restart. When a pane's start
// command launches `claude`, the app gives the conversation an id of its own
// choosing (`--session-id <uuid>`) and keeps it on the pane. After a restart
// the same command comes back as `claude --resume <uuid>`, which reloads the
// conversation and sends nothing to the model.
//
// Only a command whose first word is exactly `claude` is touched, and never
// one that already picks a conversation or runs non-interactively. Anything
// else, an alias or a script included, is typed as written.

import { mapLeaves } from "./splitTree.js";

// Canonical lowercase UUID, the only id ever typed into a shell.
const UUID_RE = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

export function isSessionId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

// Claude Code's own flags (2.1.288 `claude --help`) that an interactive,
// resumable launch can carry, by how many values each takes. A flag outside
// these tables (one that picks or forks a conversation, prints and exits,
// runs in the background or the cloud, makes a worktree, and anything
// unknown) leaves the command as typed, and so does any word that is not a
// flag or a flag's value: a positional prompt would be sent again on every
// resume, and a subcommand is not a session at all.
const SWITCHES = new Set([
  "--allow-dangerously-skip-permissions", "--ax-screen-reader", "--brief", "--chrome", "--no-chrome",
  "--dangerously-skip-permissions", "--disable-slash-commands", "--ide", "--strict-mcp-config",
  "--verbose", "--safe-mode", "--restricted", "--exclude-dynamic-system-prompt-sections",
]);
const ONE_VALUE = new Set([
  "--agent", "--agents", "--append-system-prompt", "--autocompact", "--effort", "--fallback-model",
  "--model", "--permission-mode", "--settings", "--setting-sources", "--system-prompt",
  "--system-prompt-snapshot", "--plugin-dir", "--debug-file", "-n", "--name",
]);
const OPTIONAL_VALUE = new Set(["-d", "--debug"]);
const MANY_VALUES = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--mcp-config", "--tools",
]);

// Words, with single and double quotes grouping. null for anything this does
// not model (a backslash, an unclosed quote), which leaves the command alone.
function words(text) {
  const out = [];
  let cur = null;
  let quote = null;
  for (const ch of text) {
    if (ch === String.fromCharCode(92)) return null;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (cur === null) cur = "";
      continue;
    }
    if (ch === " " || ch === String.fromCharCode(9)) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    cur = (cur ?? "") + ch;
  }
  if (quote) return null;
  if (cur !== null) out.push(cur);
  return out;
}

// Whether every word after `claude` is a known flag or one of its values.
function onlyKnownFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const flag = eq === -1 ? w : w.slice(0, eq);
    if (SWITCHES.has(flag)) {
      if (eq !== -1) return false;
    } else if (ONE_VALUE.has(flag)) {
      if (eq === -1) {
        if (i + 1 >= args.length) return false;
        i += 1;
      }
    } else if (OPTIONAL_VALUE.has(flag)) {
      if (eq === -1 && i + 1 < args.length && !args[i + 1].startsWith("-")) i += 1;
    } else if (MANY_VALUES.has(flag)) {
      if (eq === -1) {
        if (i + 1 >= args.length || args[i + 1].startsWith("-")) return false;
        while (i + 1 < args.length && !args[i + 1].startsWith("-")) i += 1;
      }
    } else {
      return false;
    }
  }
  return true;
}

// The command split around its first word, or null when that word is not
// `claude` or the rest is not only known flags and their values.
function claudeCommand(command) {
  if (typeof command !== "string") return null;
  const lead = command.length - command.trimStart().length;
  const rest = command.slice(lead);
  if (!rest.startsWith("claude")) return null;
  const after = rest.slice("claude".length);
  if (after !== "" && after[0] !== " " && after[0] !== String.fromCharCode(9)) return null;
  const args = words(after);
  if (args === null || !onlyKnownFlags(args)) return null;
  return { head: command.slice(0, lead) + "claude", tail: after };
}

export function launchesClaude(command) {
  return claudeCommand(command) !== null;
}

// `claude ...` -> `claude --session-id <id> ...`. Unchanged when the command
// is not a plain `claude` launch or the id is not a canonical UUID.
export function withSessionId(command, id) {
  const parts = claudeCommand(command);
  if (!parts || !isSessionId(id)) return command;
  return `${parts.head} --session-id ${id}${parts.tail}`;
}

// `claude ...` -> `claude --resume <id> ...`, under the same rules.
export function withResume(command, id) {
  const parts = claudeCommand(command);
  if (!parts || !isSessionId(id)) return command;
  return `${parts.head} --resume ${id}${parts.tail}`;
}

// A pane's start commands for this spawn, and the session it records. Only
// the first `claude` line is given an id; one pane holds one conversation.
// `resumeId` is a session to resume (already checked to exist), `newId` the
// id for a fresh conversation. Returns { commands, session } where session is
// { cli: "claude", id } or null when no line launches claude.
export function planAgentLaunch(commands, { resumeId = null, newId }) {
  const out = [];
  let session = null;
  for (const line of commands || []) {
    if (session === null && launchesClaude(line)) {
      if (isSessionId(resumeId)) {
        out.push(withResume(line, resumeId));
        session = { cli: "claude", id: resumeId };
        continue;
      }
      if (isSessionId(newId)) {
        out.push(withSessionId(line, newId));
        session = { cli: "claude", id: newId };
        continue;
      }
    }
    out.push(line);
  }
  return { commands: out, session };
}

// ── On the workspace tree ───────────────────────────────────────────────────
// A pane's conversation is a spawn field (activePane.js SPAWN_FIELDS): on the
// tab for its root pane, on the leaf for any other pane, so it moves with the
// pane through drag-to-split.

// `ts` (the terminals state) with pane `paneId` holding `session`, wherever
// the pane is now (drag-to-split moves panes between tabs). The same object
// back when the pane is gone, so a write that lands after a close changes
// nothing.
export function withPaneAgentSession(ts, paneId, session) {
  if (!ts || !Array.isArray(ts.panels) || !paneId) return ts;
  let changed = false;
  const panels = ts.panels.map((p) => {
    if (changed) return p;
    const tabs = p.tabs.map((t) => {
      if (changed) return t;
      if (paneId === t.id) {
        changed = true;
        return { ...t, agentSession: session || undefined };
      }
      if (!t.layout) return t;
      let found = false;
      const layout = mapLeaves(t.layout, (leaf) => {
        if (leaf.id !== paneId) return leaf;
        found = true;
        return { ...leaf, agentSession: session || undefined };
      });
      if (!found) return t;
      changed = true;
      return { ...t, layout };
    });
    return tabs.some((t, i) => t !== p.tabs[i]) ? { ...p, tabs } : p;
  });
  return changed ? { ...ts, panels } : ts;
}

// A tab with no conversation on it or on any of its panes: for a copy that
// must start fresh (duplicate, detach, a loaded workspace), since two live
// processes resuming one conversation would interleave it.
export function stripAgentSessions(tab) {
  if (!tab) return tab;
  const out = { ...tab, agentSession: undefined };
  if (tab.layout) out.layout = mapLeaves(tab.layout, (leaf) => ({ ...leaf, agentSession: undefined }));
  return out;
}
