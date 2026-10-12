// (C)
// What a tab's programs said about themselves (OSC 7501, programStatus.js),
// for the fleet views: the Agent dashboard and the Monitor dock. A tab can
// hold several panes; the words come from the pane that is waiting on you,
// else one that failed, else the first that reported. Program text is shown
// only through displayText, and only as a program's words.

import { getLayout, leafIds } from "./splitTree";
import { displayText } from "./programStatus.js";
import { paneSessionLabel } from "./activePane.js";

export function tabDetail(tab, details, activities) {
  if (!tab || !details) return null;
  const all = leafIds(getLayout(tab));
  const ids = all.filter((id) => details[id]);
  if (ids.length === 0) return null;
  const pick =
    ids.find((id) => activities?.[id] === "waiting") ||
    ids.find((id) => details[id].state === "error") ||
    ids[0];
  const d = details[pick];
  return {
    // Which pane spoke, when it is not the tab's own (a pane folded in from
    // another host shows that host), so its words are not read as the tab's.
    pane: pick === tab.id ? "" : paneSessionLabel(tab, pick, all.indexOf(pick), all.length),
    failed: d.state === "error",
    kind: d.kind || null,
    app: displayText(d.app || "", 32),
    msg: displayText(d.msg || "", 120),
  };
}

// One short line for a row: the program's message, labelled as its own, or
// what the program is blocked on. Empty when there is nothing to add.
export function detailLine(detail, status) {
  if (!detail) return "";
  const line = detailWords(detail, status);
  return line && detail.pane ? `${detail.pane}: ${line}` : line;
}

function detailWords(detail, status) {
  const who = detail.app || "program";
  if (detail.msg) return `${who}: ${detail.msg}`;
  if (status === "waiting" && detail.kind === "question") return `${who} has a question`;
  if (status === "waiting" && detail.kind === "auth") return `${who} asks you to sign in`;
  if (detail.failed) return `${who} stopped with an error`;
  return "";
}
