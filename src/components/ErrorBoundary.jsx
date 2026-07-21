// (C)
// Top-level error boundary. A render-time throw (e.g. a malformed persisted layout
// after a bad sync/merge, or a component bug) otherwise drops the whole app to a
// blank white screen with no recovery but relaunch. This catches it and offers a
// way out. Critically, one option clears ONLY the per-window layout storage key, so
// a poisoned persisted blob can't loop blank -> reload -> blank; snippets, themes,
// and keys (separate keys) are kept.
import { Component } from "react";
import { destroyAll } from "../features/terminals/paneRegistry.js";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try { console.error("Pluto's Terminal: uncaught render error", error, info); } catch { /* never throw here */ }
    // A crashed tree cannot supervise live sessions.
    try { destroyAll(); } catch { /* the boundary must never throw */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const reload = () => { try { window.location.reload(); } catch { /* noop */ } };
    const resetLayout = () => {
      try { if (this.props.storageKey) localStorage.removeItem(this.props.storageKey); } catch { /* noop */ }
      reload();
    };
    const btn = {
      padding: "10px 16px", marginRight: 10, borderRadius: 8, border: "1px solid #333",
      background: "#1e2228", color: "#cfd6dd", cursor: "pointer", fontSize: 14,
    };
    return (
      <div style={{ position: "fixed", inset: 0, background: "#0b0d0f", overflow: "auto" }}>
        <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "-apple-system, 'Segoe UI', sans-serif", color: "#cfd6dd" }}>
          <h2 style={{ color: "#E05B5B", margin: "0 0 8px" }}>Something broke.</h2>
          <p style={{ color: "#8a939e", fontSize: 13, lineHeight: 1.5 }}>
            The app hit an unexpected error and stopped rendering. Reload to try again.
            If it keeps happening, reset the window layout, which clears the saved
            panels/tabs for this window only. Your snippets, themes, and keys are kept.
          </p>
          <pre style={{ fontSize: 11, color: "#6b7480", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 140, overflow: "auto", background: "#111", padding: 10, borderRadius: 6 }}>
            {String(this.state.error?.message || this.state.error || "")}
          </pre>
          <div style={{ marginTop: 16 }}>
            <button style={btn} onClick={reload}>Reload</button>
            <button style={{ ...btn, marginRight: 0, borderColor: "#E0A04F", color: "#E0A04F" }} onClick={resetLayout}>
              Reset layout &amp; reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
