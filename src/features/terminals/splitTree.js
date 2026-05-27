// (C)
// A tab's pane layout is a binary tree. Tabs start as a single pane and can be
// split horizontally (side-by-side) or vertically (stacked), WindTerm-style.
//
//   Leaf:  { id, cwd? }                       — one terminal pane
//   Split: { id, dir: 'row'|'col', ratio, a, b }
//     dir 'row' = panes side-by-side, draggable vertical divider, ratio = width
//     dir 'col' = panes stacked,      draggable horizontal divider, ratio = height
//
// A tab with no `layout` is an implicit single leaf whose id === tab.id, so the
// root pane reuses the tab's PTY + scrollback file and existing single-pane tabs
// keep working untouched.

export function isLeaf(node) {
  return !!node && node.id != null && !node.dir;
}

// The node to render for a tab: its stored layout, or an implicit root leaf.
export function getLayout(tab) {
  return tab.layout || { id: tab.id, cwd: tab.cwd ?? null };
}

// Every leaf id in the tree (each maps to one live PTY / scrollback file).
export function leafIds(node) {
  if (!node) return [];
  if (isLeaf(node)) return [node.id];
  return [...leafIds(node.a), ...leafIds(node.b)];
}

// Every leaf object in the tree.
export function leaves(node) {
  if (!node) return [];
  if (isLeaf(node)) return [node];
  return [...leaves(node.a), ...leaves(node.b)];
}

// Split the leaf with id === targetId into two, adding `newLeaf` as the b-side.
export function splitLeaf(node, targetId, dir, newLeaf, splitId) {
  if (!node) return node;
  if (isLeaf(node)) {
    if (node.id !== targetId) return node;
    return { id: splitId, dir, ratio: 0.5, a: node, b: newLeaf };
  }
  return {
    ...node,
    a: splitLeaf(node.a, targetId, dir, newLeaf, splitId),
    b: splitLeaf(node.b, targetId, dir, newLeaf, splitId),
  };
}

// Remove the leaf with id === targetId; collapse its parent split to the
// surviving sibling. Returns the new tree, or null if that was the last leaf.
export function removeLeaf(node, targetId) {
  if (!node) return null;
  if (isLeaf(node)) return node.id === targetId ? null : node;
  const a = removeLeaf(node.a, targetId);
  const b = removeLeaf(node.b, targetId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

// Set the divider ratio (0..1) of the split node with id === splitId.
export function setRatio(node, splitId, ratio) {
  if (!node || isLeaf(node)) return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    a: setRatio(node.a, splitId, ratio),
    b: setRatio(node.b, splitId, ratio),
  };
}
