// (C)
// Shared UI primitives for Pluto's Terminals — one design system across every
// dialog so spacing, type, color, and interaction states stay consistent
// instead of each modal improvising its own inline styles. Styling lives in the
// .phn-ui-* classes (see headerSkins.js) so :hover / :focus-visible / :disabled
// are real CSS states driven by the design tokens.

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// Button — variant: "primary" | "ghost" | "subtle" | "danger"; size: "sm" | "md".
export function Button({ variant = "ghost", size = "md", className, type = "button", children, ...rest }) {
  return (
    <button
      type={type}
      className={cx("phn-ui-btn", `phn-ui-btn--${variant}`, size === "sm" && "phn-ui-btn--sm", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// Text input. Pass mono for monospace (model ids, endpoints, commands).
export function Input({ mono, className, ...rest }) {
  return <input className={cx("phn-ui-input", mono && "phn-ui-input--mono", className)} spellCheck={false} {...rest} />;
}

export function Textarea({ className, rows = 3, ...rest }) {
  return <textarea className={cx("phn-ui-input", "phn-ui-input--mono", className)} rows={rows} spellCheck={false} {...rest} />;
}

// Labeled field wrapper: uppercase caption + optional hint below the control.
export function Field({ label, hint, children, className, style }) {
  return (
    <div className={cx("phn-ui-field", className)} style={style}>
      {label && <label className="phn-ui-label">{label}</label>}
      {children}
      {hint && <div className="phn-ui-hint">{hint}</div>}
    </div>
  );
}

// Selectable chip (model presets, tags, filter pills).
export function Chip({ active, className, children, ...rest }) {
  return (
    <button className={cx("phn-ui-chip", active && "phn-ui-chip--active", className)} {...rest}>
      {children}
    </button>
  );
}

export function Kbd({ children }) {
  return <kbd className="phn-ui-kbd">{children}</kbd>;
}
