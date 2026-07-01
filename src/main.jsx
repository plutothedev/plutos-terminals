import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// Preload the bundled powerline font so xterm terminals (opened after launch)
// measure glyph widths with it already cached — avoids first-tab layout jitter.
if (typeof document !== "undefined" && document.fonts?.load) {
  document.fonts.load("13px 'MesloLGS NF'").catch(() => {});
}

// Surface unhandled promise rejections instead of silently swallowing them; paired
// with the top-level ErrorBoundary (which catches render-time throws) for basic
// resilience against otherwise-invisible failures.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    try { console.error("Pluto's Terminal: unhandled promise rejection", e.reason); } catch { /* noop */ }
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
