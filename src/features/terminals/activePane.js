// (C)
// Which PANE a chrome-level "act on the active terminal" action must address.
//
// The PTY-facing registries are all keyed by PANE id, not TAB id: TerminalPanel
// renders each leaf of a tab's split tree as `<TerminalPane tabId={node.id}>`,
// and that pane registers itself under that id with ptyBridge
// (registerPtyWriter / registerTabReader / setPtyId), the asciinema recorder
// (pushOutput) and the macro capture (recordInput). The chrome, meanwhile, only
// knows `panel.activeTabId`. The two ids coincide in exactly one case: an
// unsplit tab that still owns its original pane.
//
// Two structural reasons they diverge (audit FE-1):
//   1. splitLeaf() keeps the existing leaf's id and adds the NEW leaf beside it,
//      so on a split tab `tab.id` is permanently the FIRST leaf, while
//      useWorkspaceTree moves focus to the new leaf. An action keyed on tab.id
//      lands in the pane the user just split away from.
//   2. removeLeaf() collapses a two-leaf tree to its surviving sibling, so
//      closing the ORIGINAL pane leaves a tab where NO leaf id equals tab.id.
//      Every tab.id lookup is then `undefined` for the life of that tab.
//
// Hence: validate the stored activePaneId against the tab's LIVE leaf set and
// fall back to the first leaf. Never fall back to tab.id: that is precisely the
// id that case 2 makes dead.
import { getLayout, leafIds, leaves } from "./splitTree.js";

// ── What a pane runs ────────────────────────────────────────────────────────
// A tab's ROOT leaf (the leaf whose id is the tab's id) runs the tab's own
// spawn fields. Every other leaf runs what is stored on the leaf. Until remote
// tabs could be folded into a split, every non-root leaf was a local shell
// born from splitLeaf, carrying at most a cwd, and several readers relied on
// "non-root means local". Drag-to-split now folds an SSH or serial tab into
// another tab's layout, and moveTabIntoSplit stamps that tab's spawn fields onto
// its leaf. These are the one place that rule lives, so what a pane spawns
// (TerminalPanel), which machine a broadcast keystroke reaches (the broadcast
// picker) and what the dock tools connect to cannot disagree.
const SPAWN_FIELDS = ["cwd", "connection", "serial", "startCommands", "systemPrompt"];

// The spawn fields of a non-root leaf, for a caller that already holds it.
export function leafSpawnConfig(leaf) {
  const out = {};
  for (const f of SPAWN_FIELDS) out[f] = leaf?.[f] ?? null;
  return out;
}

// The spawn fields pane `paneId` of `tab` runs with. Field values keep their
// identity (the same connection object the tab or leaf holds), so memoized
// panes see no change when nothing changed.
export function paneSpawnConfig(tab, paneId) {
  if (!tab || paneId == null) return leafSpawnConfig(null);
  if (paneId === tab.id) {
    const out = {};
    for (const f of SPAWN_FIELDS) out[f] = tab[f] || null;
    return out;
  }
  return leafSpawnConfig(leaves(getLayout(tab)).find((l) => l.id === paneId));
}

// The SSH session the tab-wide tools act on (the SFTP dock, port forwarding,
// the network tools' default host): the focused pane's own connection when it
// has one (an SSH tab's root, or an SSH pane folded in by drag-to-split), else
// the tab's root connection, which is all these tools ever used, so a local
// pane split off an SSH tab keeps the dock on that host as before. `paneId` is
// the pane that connection belongs to: the in-memory SSH password is stored
// under that pane's id (TerminalPane's setTabPassword(tabId), tabId = pane id).
export function activeSshContext(tab) {
  if (!tab) return null;
  const paneId = resolveActivePaneId(tab);
  const own = paneId != null ? paneSpawnConfig(tab, paneId).connection : null;
  if (own) return { connection: own, paneId };
  return tab.connection ? { connection: tab.connection, paneId: tab.id } : null;
}

// The address a pane types into, written the way people write it: user@host,
// plus ":port" when the port is not SSH's default 22 (behind one NAT address,
// two ports are often two machines), or a serial pane's device path. Null for
// a local pane. An IPv6 host is bracketed when a port follows it.
export function paneAddress(spawn) {
  const c = spawn?.connection;
  if (c?.host) {
    const port = Number(c.port) || 22;
    const host = port !== 22 && String(c.host).includes(":") ? `[${c.host}]` : c.host;
    return `${c.user ? `${c.user}@` : ""}${host}${port !== 22 ? `:${port}` : ""}`;
  }
  return spawn?.serial?.path || null;
}

// The label a pane carries in session lists (the phone companion's): the tab's
// label, " ·N" for pane N of a split, and the address the pane really types
// into wherever the tab's label could suggest another one. The phone can type
// into any session, so neither an SSH pane folded into a local tab ("work ·2")
// nor a local pane split off an SSH tab ("deploy@prod ·2") may pass for the
// other. The tab's label describes its ROOT pane only: a root pane whose label
// already names its address as a whole word ("deploy@prod.example") is left
// alone, every other remote pane gets its address, and a local pane in a tab
// whose root is remote gets "(local)".
export function paneSessionLabel(tab, paneId, index, count) {
  const base = count > 1 ? `${tab?.label || "shell"} ·${index + 1}` : tab?.label || "shell";
  const where = paneAddress(paneSpawnConfig(tab, paneId));
  const isRoot = tab != null && paneId === tab.id;
  if (where) return isRoot && namesWord(base, where) ? base : `${base} (${where})`;
  if (!isRoot && (tab?.connection || tab?.serial)) return `${base} (local)`;
  return base;
}

// Whether `label` contains `word` as a whole word, ignoring case: neither
// neighbour may be a character an address can continue with. ":" counts, so a
// label naming "fe80::1:2" or "prod.example:2222" does not name "fe80::1" or
// port 22's "prod.example". "deploy@prod.example" names itself; "db-10.0.0.50"
// does not name "10.0.0.5", and "staging (prod mirror)" names no address.
const HOST_CHAR = /[a-z0-9._:-]/i;
function namesWord(label, word) {
  const l = String(label).toLowerCase();
  const w = String(word).toLowerCase();
  for (let i = l.indexOf(w); i !== -1; i = l.indexOf(w, i + 1)) {
    const before = i > 0 ? l[i - 1] : "";
    const after = l[i + w.length] ?? "";
    if (!HOST_CHAR.test(before) && !HOST_CHAR.test(after)) return true;
  }
  return false;
}

export function resolveActivePaneId(tab) {
  if (!tab || tab.id == null) return null;
  const leaves = leafIds(getLayout(tab));
  // getLayout always yields at least an implicit root leaf, so this is
  // defensive only (a hand-edited / corrupt layout blob with a null branch).
  if (leaves.length === 0) return tab.id;
  const stored = tab.activePaneId;
  if (stored != null && leaves.includes(stored)) return stored;
  return leaves[0];
}

// Every pane id the given panels currently render, as a Set. Used as the live
// set for pruning pane-keyed side registries (the recorder) on the same
// commit-time sweep that reconciles the pane registry. Special tabs
// (home/vnc/rdp/notebook) mount no TerminalPane, so their ids are included via
// resolveActivePaneId's own fallback. They can hold a recording that records
// nothing, and pruning it out from under a "● rec" indicator mid-session would
// be a worse lie than letting it sit until the tab closes.
export function allPaneTargets(panels) {
  const ids = new Set();
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      for (const id of leafIds(getLayout(tab))) ids.add(id);
    }
  }
  return ids;
}

// The panel + tab that owns a given pane id, or null. The status bar hands back
// a recording's key (a PANE id) and the app has to focus the terminal it
// belongs to, which on a split tab is not a tab whose id matches.
export function findPaneOwner(panels, paneId) {
  if (paneId == null) return null;
  for (const panel of panels || []) {
    for (const tab of panel.tabs || []) {
      if (leafIds(getLayout(tab)).includes(paneId)) return { panel, tab };
    }
  }
  return null;
}
