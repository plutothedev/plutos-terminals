// (C)
// Tracks the OS color scheme (prefers-color-scheme: dark) and re-renders when it
// flips. Used to drive the optional "Sync with OS light/dark" theme mode.

import { useEffect, useState } from "react";

const QUERY = "(prefers-color-scheme: dark)";

function readOsDark() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY).matches
    : true; // default to dark when unknown
}

export function useOsDark() {
  const [dark, setDark] = useState(readOsDark);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = (e) => setDark(e.matches);
    // Safari < 14 only has the deprecated addListener/removeListener.
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return dark;
}
