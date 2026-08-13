// (C)
// Boot-stagger trickle core (P4-T5; extracted after the mini-review so the
// scheduling contract is testable without mounting TerminalsTab). One call =
// one tick: release the FIRST tab (render order) that still has an unspawned
// pane — every pane of that tab together, so a split tab costs one slot —
// then ask the caller to reschedule. Returns true if it released something
// (caller reschedules), false when nothing is left (caller lets the timer
// die; the TerminalsTab effect re-arms on the next state.panels change, which
// is the fix for the mini-review HIGH: a workspace loaded AFTER the boot
// trickle exhausted used to leave its hidden agent tabs inert forever).
import { tabPaneIdGroups } from "./paneIds.js";
import { getEntry as registryGetEntry } from "./paneRegistry.js";

export function trickleTick(panels, getEntry = registryGetEntry) {
  for (const { paneIds } of tabPaneIdGroups(panels)) {
    const entries = paneIds.map(getEntry).filter(Boolean);
    if (entries.some((e) => e.spawnState === "unspawned")) {
      for (const e of entries) e.startSpawn?.();
      return true;
    }
  }
  return false;
}
