// (C)
// The one component allowed to subscribe to the dims channel (P2-T5). Renders
// the active tab's cols×rows; a split-drag or window resize re-renders THIS
// span, not TerminalsTab + the whole chrome. Both chrome bars use it.
import { getTabDims } from "../ptyBridge.js";
import { useDimsListener } from "../hooks/independentEffects.js";

export default function ActiveDims({ tabId, className, style, prefix = null }) {
  useDimsListener();
  const dims = tabId ? getTabDims(tabId) : null;
  if (!dims) return null;
  return (
    <span className={className} style={style}>
      {prefix}
      {dims.cols}×{dims.rows}
    </span>
  );
}
