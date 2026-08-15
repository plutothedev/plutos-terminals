// (C)
// Module registry of remote-file editors that currently hold unsaved changes
// (audit C4). RemoteEditor is a floating Modal owned by SftpBrowser; closing the
// TAB that hosts its SSH session unmounts it without going through the modal's
// own onClose dirty-guard, so tab-close paths consult this registry to confirm
// before silently dropping unsaved remote edits.
const dirty = new Set();

export function markRemoteEditDirty(key) {
  if (key) dirty.add(key);
}
export function clearRemoteEditDirty(key) {
  if (key) dirty.delete(key);
}
export function hasUnsavedRemoteEdits() {
  return dirty.size > 0;
}
