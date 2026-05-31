// (C)
// Fresh, collision-resistant ids for panels / tabs / panes / projects. A short
// timestamp + random suffix is enough — these key React lists and scrollback
// files, not anything security-sensitive. Shared so the session/grid hooks and
// TerminalsTab's layout helpers all mint ids the same way.
export function freshId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
