// (C)
// MultiExec broadcast mode, lifted verbatim out of the TerminalsTab god
// component. Transient per-window mode: when on, a keystroke or snippet goes to
// every visible terminal at once. NOT persisted (auto-typing into every pane
// after a restart would surprise). The bridge mirrors the flag + explicit
// targets down to the PTY layer (setBroadcast / setBroadcastTargets) so writes
// fan out to the right terminals. `toast` is injected so applyBroadcastGroup
// can confirm the target count.

import { useCallback, useState } from "react";
import { setBroadcast, setBroadcastTargets } from "../ptyBridge.js";

export function useBroadcastMode(toast) {
  const [broadcast, setBroadcastState] = useState(false);
  const [bcastTargets, setBcastTargets] = useState(null); // null = all visible; array = explicit group
  const toggleBroadcast = useCallback(() => {
    setBroadcastState((on) => {
      const next = !on;
      setBroadcast(next);
      // The plain toggle is always "all visible" — clear any explicit group.
      setBroadcastTargets(null);
      setBcastTargets(null);
      return next;
    });
  }, []);
  const applyBroadcastGroup = useCallback((ids) => {
    setBroadcastTargets(ids);
    setBcastTargets(ids);
    setBroadcast(true);
    setBroadcastState(true);
    toast.success(`Broadcasting to ${ids.length} terminal${ids.length === 1 ? "" : "s"}.`);
  }, [toast]);
  const useAllVisibleBroadcast = useCallback(() => {
    setBroadcastTargets(null);
    setBcastTargets(null);
    setBroadcast(true);
    setBroadcastState(true);
  }, []);

  return { broadcast, bcastTargets, toggleBroadcast, applyBroadcastGroup, useAllVisibleBroadcast };
}
