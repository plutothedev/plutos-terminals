// (C)
// Single-flight guard for actions that open a confirm (v0.7.6 audit).
// ConfirmModal queues confirms FIFO, so a second request for the same action
// while the first one's dialog is still open (a double click, a shortcut
// pressed twice) stacked an identical dialog behind it, and answering the
// first left the user facing the same question again.
//
// `flights` is a Set the caller owns and keeps across renders (a useRef), so
// re-created callbacks share it. Returns the action's result, or undefined
// without running it while the same key is still in flight.
export async function runExclusive(flights, key, action) {
  if (flights.has(key)) return undefined;
  flights.add(key);
  try {
    return await action();
  } finally {
    flights.delete(key);
  }
}
