<!--
Sync Impact Report
Version change: (none) → 1.0.0
Bump rationale: Initial ratification of the project constitution (no prior versioned document).
Modified principles: n/a (first version)
Added sections:
  - Core Principles I–VII
  - Technology Constraints
  - Development Workflow
  - Governance
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ reviewed — generic "Constitution Check" gate aligns; no edit needed
  - .specify/templates/spec-template.md ✅ reviewed — scope/requirements structure compatible; no edit needed
  - .specify/templates/tasks-template.md ✅ reviewed — task categories compatible; verify-live gate added via workflow note below
Follow-up TODOs: none
-->

# Pluto's Terminals Constitution

Pluto's Terminals is a multi-terminal desktop app (Tauri 2 + React 18 + Vite + xterm.js,
Rust 2021 backend) shipped as a free gift to the Pluto community. This constitution
captures the non-negotiable rules that every spec, plan, and implementation MUST honor.

## Core Principles

### I. v0-First Discipline

v0 MUST reach a working dev binary on Pluto's machine and be pushed to GitHub before any
v1/v2 feature work begins. The deferred v1 features — agent grid panel, in-app prompt-pack
browser / auto-loader, one-click Anthropic API key config, MCP installer — MUST NOT be
started until v0's kill-switch criteria have been measured. The kill-switch is real: if v0
does not pull community engagement, the project does not sunk-cost into v1. Any spec that
introduces a v1/v2 capability MUST be rejected at the Constitution Check unless v0 is
demonstrably shipped.

Rationale: The product's value is proven by a shipped, used v0 — not by accumulating
unshipped scope.

### II. Verify Live After Each Phase (NON-NEGOTIABLE)

A green `npm run build` / `cargo build` is NOT evidence that the app renders. Every phase
MUST end by launching the running app and confirming the change visually (screenshot the
live window, filtered to the Pluto's Terminals window). Subtle failures — e.g. a
`useCallback` deps array referencing a later-declared const causing a TDZ blank screen —
compile cleanly yet break the app. No phase is "done" without a live observation.

Rationale: WKWebView and React runtime failures are invisible to the compiler; only the
running app tells the truth.

### III. Authorship Marker

Every Claude-authored file MUST include a `(C)` marker near the top — `<!-- (C) -->` in
markup/markdown or `// (C)` in source — so authorship is traceable. Files written by Pluto
MUST NOT be edited as if they were Claude's (no rewriting Pluto's own prose).

Rationale: Clear authorship boundaries keep the two-Claude protocol and Pluto's voice
intact.

### IV. MobaXterm v12.4 Dark Fidelity

The Pro terminal overhaul targets **MobaXterm v12.4 in its DARK theme** as the visual
fidelity reference (not the light theme, not a later version). Pro-overhaul UI specs MUST
state how they match this reference and SHOULD be screenshot-verified against it.

Rationale: A concrete, frozen reference prevents UI drift and subjective "good enough."

### V. Brain/Operations Boundary

Operational state — PTY sessions, scrollback, transcripts — MUST live under `data/` next to
`package.json` in dev, or `%APPDATA%/com.plutothedev.terminals/` in production. The vault
project meta MUST NOT mirror code state, and code MUST NOT write into the vault. The two
stores stay separate.

Rationale: Mixing durable strategy notes with ephemeral runtime state corrupts both.

### VI. Lyfe Cherry-Pick vs Diverge Gate

When Lyfe ships terminal improvements, each change passes a decision gate: **default to
cherry-pick for non-UX changes** (PTY robustness, performance, correctness) and **diverge
for UX changes** (Pluto's Terminals owns its own brand voice and interaction design). Specs
that touch lifted-from-Lyfe code MUST declare which side of the gate they fall on.

Rationale: Inherit Lyfe's engineering hardening without inheriting its product identity.

### VII. Renderer & Build Constraints

The xterm WebGL renderer MUST NOT be re-added — it blanks in WKWebView. The Rust SSH path
MUST keep `vendored-openssl` so the arm64 build links. Any spec proposing to change the
renderer backend or the OpenSSL linkage MUST justify it against these known failures and
prove it on a live arm64 build.

Rationale: These are scar-tissue constraints from real, reproduced build/runtime breakage.

## Technology Constraints

- **Frontend:** React 18, Vite, xterm.js 5.x + addon-fit + addon-web-links. No WebGL addon.
- **Backend:** Rust 2021, Tauri 2.x, portable-pty (ConPTY on Windows, native PTYs
  elsewhere). SSH via ssh2 with `vendored-openssl`.
- **Persistence:** localStorage for UI state; filesystem via `commands::write_store` /
  `read_store` for scrollback and transcripts.
- **Identity:** productName "Pluto's Terminals", identifier `com.plutothedev.terminals`,
  dev URL `http://localhost:5310`.
- Sessions MUST be killed on app exit (`RunEvent::ExitRequested` → `kill_all`) so no orphan
  shells survive.

## Development Workflow

- Feature work flows through spec-kit: `constitution` → `specify` → (`clarify`) → `plan` →
  `tasks` → (`analyze`) → `implement`. Each artifact is the input to the next.
- Every `plan` MUST include a Constitution Check that verifies the seven principles above;
  a violation either gets the design changed or an explicit, justified exception recorded.
- Every implementation phase MUST satisfy Principle II (verify live) before being marked
  complete.
- Work happens on feature branches; the git extension auto-commits artifacts at each phase
  boundary when the user approves the optional commit hook.

## Governance

This constitution supersedes ad-hoc practice. When it conflicts with a spec or plan, the
constitution wins unless the user explicitly amends it.

- **Amendments** are made by editing this file via `/speckit-constitution`, which bumps the
  version and records a Sync Impact Report.
- **Versioning policy** (semantic):
  - MAJOR — a principle is removed or redefined in a backward-incompatible way.
  - MINOR — a new principle or section is added, or guidance is materially expanded.
  - PATCH — wording, clarifications, or non-semantic refinements.
- **Compliance review** — every plan's Constitution Check is the enforcement point; specs
  that violate a principle MUST be revised or carry a documented exception.
- User instructions always take precedence over this document; it encodes defaults, not
  overrides of a direct request from Pluto.

**Version**: 1.0.0 | **Ratified**: 2026-05-29 | **Last Amended**: 2026-05-29
