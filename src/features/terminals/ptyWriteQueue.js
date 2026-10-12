// (C)
// One pane's writes into its PTY, in the order they were made. Each write
// used to be its own `pty_write` invoke, and the backend runs invokes on a
// multi-threaded pool, so two writes issued a moment apart could land in
// either order. Some orders are a protocol: a program that probes for OSC 7501
// (programStatus.js) expects the terminal's reply to arrive before the reply
// to the `CSI c` it sent right after. So one invoke is in flight at a time,
// and whatever arrives meanwhile is joined and sent next, in arrival order.
// The first write to an idle queue is sent at once, so typing is no slower.

// A PTY whose program stopped reading cannot take more input; past this much
// waiting text, further writes are dropped rather than held without end.
export const MAX_PENDING_CHARS = 4 * 1024 * 1024;

export function createWriteQueue(send) {
  let inFlight = false;
  let pending = "";
  const pump = () => {
    if (inFlight || pending === "") return;
    const data = pending;
    pending = "";
    inFlight = true;
    let sent;
    try {
      sent = send(data);
    } catch {
      sent = null;
    }
    Promise.resolve(sent)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        pump();
      });
  };
  return {
    write(data) {
      if (typeof data !== "string" || data === "") return;
      if (pending.length + data.length > MAX_PENDING_CHARS) return;
      pending += data;
      pump();
    },
    get pendingLength() {
      return pending.length;
    },
  };
}
