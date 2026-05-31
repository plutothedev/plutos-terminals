// (C)
// Persisted user snippets, lifted verbatim out of the TerminalsTab god
// component. Seeded from the built-in starter set on first use so the drawer is
// never empty; edits/additions/deletes persist to the DISJOINT st.snippets key
// via save() — NOT st.terminalsState. Snippets are window-independent app state,
// so they intentionally bypass persist() (which writes the per-window panels).

import { useCallback } from "react";
import { DEFAULT_SNIPPETS } from "../SnippetsDrawer.jsx";

export function useSnippets(st, save) {
  const snippets = Array.isArray(st?.snippets) ? st.snippets : DEFAULT_SNIPPETS;
  const setSnippets = useCallback((next) => {
    save({ ...st, snippets: next });
  }, [st, save]);
  return { snippets, setSnippets };
}
