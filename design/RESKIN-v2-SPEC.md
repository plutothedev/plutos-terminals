# Pluto's Terminals — Reskin v2.0 Design Specification

> **Status:** Planning complete — ready for Claude Code execution
> **Targets:** WindTerm + MobaXterm + Termius feature parity + Linear/Warp visual language
> **Scope:** Full UI reskin + new session-management sidebar + status bar + enhanced tabs
> **Effort estimate:** 2–3 Claude Code sessions

---

## 1. Design Philosophy

### Primary Inspiration: Termius
Termius has the cleanest, most modern terminal UI. We adopt its layout patterns:
- **Left sidebar** collapsible panel: Hosts → Groups → Keychain → Snippets → Port Forwarding → SFTP
- **Top toolbar** with connection controls, layout picker, search
- **Sleek tab bar** per panel with close buttons and connection status dots
- **Bottom status bar** with connection info, encoding, cursor position

### Secondary Inspiration: WindTerm
WindTerm brings power-user density:
- **Session tree** in sidebar with folders/groups
- **Bottom dock** for SFTP browser / file manager
- **Quick command** snippets palette

### Tertiary Inspiration: MobaXterm
MobaXterm's all-in-one toolbox feel:
- **Multi-protocol** session types (SSH, local, serial, WSL)
- **Tools sidebar** with network tools, macros
- **Session manager** with rich metadata

### Visual Language: Linear × Warp
- **Linear**: Near-black surfaces (`#08090a`), semi-transparent white borders (`rgba(255,255,255,0.06)`), indigo-violet accent (`#5e6ad2`), Inter Variable typography, weight 510 emphasis
- **Warp**: Warm dark option (`#0f0f0e`), warm parchment text (`#faf9f6`), restrained muted buttons

---

## 2. Color System (New "Pro" Skin)

### Background Surfaces
| Token | Value | Usage |
|-------|-------|-------|
| `--pro-bg-deep` | `#010102` | Deepest canvas (marketing black) |
| `--pro-bg-page` | `#08090a` | App background, sidebar bg |
| `--pro-bg-panel` | `#0f1011` | Terminal panels, elevated surfaces |
| `--pro-bg-card` | `#141516` | Cards, dropdowns, popovers |
| `--pro-bg-hover` | `#1a1a1b` | Hover states, active list items |
| `--pro-bg-input` | `rgba(255,255,255,0.03)` | Input fields, search boxes |

### Text
| Token | Value | Usage |
|-------|-------|-------|
| `--pro-text-primary` | `#f7f8f8` | Headlines, active tabs, important labels |
| `--pro-text-secondary` | `#b4b8c0` | Body text, descriptions |
| `--pro-text-tertiary` | `#8a8f98` | Metadata, timestamps, hints |
| `--pro-text-quaternary` | `#62666d` | Disabled, placeholders |
| `--pro-text-link` | `#828fff` | Links, interactive accents |

### Accent & Brand
| Token | Value | Usage |
|-------|-------|-------|
| `--pro-accent` | `#5e6ad2` | Primary buttons, active indicators, brand elements |
| `--pro-accent-hover` | `#828fff` | Hover on accent elements |
| `--pro-accent-subtle` | `rgba(94,106,210,0.15)` | Accent backgrounds, selected row bg |
| `--pro-success` | `#10b981` | Connected status, success states |
| `--pro-warning` | `#f59e0b` | Warnings, attention |
| `--pro-error` | `#ef4444` | Errors, disconnected status |

### Borders
| Token | Value | Usage |
|-------|-------|-------|
| `--pro-border-subtle` | `rgba(255,255,255,0.04)` | Dividers, section separators |
| `--pro-border-standard` | `rgba(255,255,255,0.06)` | Cards, inputs, panels |
| `--pro-border-strong` | `rgba(255,255,255,0.10)` | Focus rings, active borders |

### Warm Variant ("Warm Pro" — Warp-inspired)
Swap the cool grays for warm equivalents:
| Token | Value |
|-------|-------|
| `--warm-bg-page` | `#0f0f0e` |
| `--warm-text-primary` | `#faf9f6` |
| `--warm-text-secondary` | `#afaeac` |
| `--warm-border` | `rgba(226,226,226,0.08)` |
| `--warm-accent` | `#d4a574` |

---

## 3. Typography

### Font Stack
```css
--font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
```

### Hierarchy
| Role | Size | Weight | Line Height | Letter Spacing | Color |
|------|------|--------|-------------|----------------|-------|
| App title | 13px | 600 | 1.2 | 0.02em | `--pro-text-primary` |
| Section header | 11px | 600 | 1.2 | 0.06em | `--pro-text-tertiary` (uppercase) |
| Sidebar item | 13px | 400 | 1.4 | 0 | `--pro-text-secondary` |
| Sidebar item active | 13px | 500 | 1.4 | 0 | `--pro-text-primary` |
| Tab label | 12px | 500 | 1.2 | 0.01em | `--pro-text-secondary` |
| Tab label active | 12px | 500 | 1.2 | 0.01em | `--pro-text-primary` |
| Toolbar button | 12px | 500 | 1.2 | 0 | `--pro-text-tertiary` |
| Status bar | 11px | 400 | 1.2 | 0.01em | `--pro-text-quaternary` |
| Terminal text | 14px | 400 | 1.2 | 0 | (xterm theme) |

---

## 4. Layout Architecture

### Overall Structure
```
┌─────────────────────────────────────────────────────────────┐
│  [≡]  Pluto's Terminals          [🔍] [⊕] [⚙] [─] [□] [×] │  ← Title bar (drag region)
├──────┬──────────────────────────────────────────────────────┤
│      │  📂 Home  │  📂 Work  │  +  │         [🔍] [⧉] [⋮]  │  ← Tab bar per panel
│ HOST │───────────────────────────────────────────────────────│
│ SIDEB│  ┌────────────────────────────────────────────────┐  │
│ BAR  │  │                                                │  │
│      │  │         TERMINAL / PTY CONTENT                 │  │
│      │  │                                                │  │
│      │  │                                                │  │
│      │  └────────────────────────────────────────────────┘  │
│      │───────────────────────────────────────────────────────│
│      │  📂 Home  │  +  │                                    │  ← Second panel (if split)
│      │───────────────────────────────────────────────────────│
│      │  ┌────────────────────────────────────────────────┐  │
│      │  │         TERMINAL / PTY CONTENT                 │  │
│      │  └────────────────────────────────────────────────┘  │
├──────┴──────────────────────────────────────────────────────┤
│  ◉ Connected  │  UTF-8  │  Ln 12, Col 34  │  sh  │  1.2MB   │  ← Status bar
└─────────────────────────────────────────────────────────────┘
```

### Left Sidebar (collapsible, 240px default, 48px collapsed)
**Sections (collapsible accordion):**
1. **Hosts** — tree view: Group → Host entries. Each host has: connection status dot, name, protocol icon (SSH/local/WSL), last-used timestamp
2. **Keychain** — SSH key pairs, agent status, fingerprints
3. **Snippets** — saved command snippets, searchable, drag-to-terminal
4. **Port Forwarding** — active tunnels, add/remove
5. **SFTP** — remote file browser (when connected)

**Sidebar Header:**
- App logo + name (collapses to icon only)
- Toggle button (≡)

### Top Toolbar (per panel, 40px height)
- **Left:** Panel tabs (draggable, closable), new tab (+)
- **Right:** Split layout button, search in terminal, panel menu (⋮)

### Tab Bar (per panel)
- Horizontal tabs with: favicon/status dot, label, close (×)
- Active tab has bottom accent border (`--pro-accent`)
- Hover shows close button
- Overflow scrolls with ← → arrows

### Terminal Area
- Each panel contains one active terminal (xterm.js)
- Panel chrome: subtle border (`--pro-border-standard`)
- Active panel has slightly brighter border (`--pro-border-strong`)
- Focused panel: optional rainbow border (keep existing feature)

### Bottom Status Bar (28px height)
- **Left:** Connection status (● green = connected, ● red = disconnected), host name
- **Center:** Encoding, line/column, shell type
- **Right:** Data transferred, bell toggle, zoom level

---

## 5. Component Specifications

### Sidebar
```css
.sidebar {
  width: 240px;
  background: var(--pro-bg-page);
  border-right: 1px solid var(--pro-border-subtle);
  display: flex;
  flex-direction: column;
}

.sidebar.collapsed {
  width: 48px;
}

.sidebar-section {
  border-bottom: 1px solid var(--pro-border-subtle);
}

.sidebar-section-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pro-text-tertiary);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
}

.sidebar-item {
  padding: 6px 12px 6px 24px;
  font-size: 13px;
  color: var(--pro-text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  border-radius: 4px;
  margin: 0 4px;
}

.sidebar-item:hover {
  background: var(--pro-bg-hover);
  color: var(--pro-text-primary);
}

.sidebar-item.active {
  background: var(--pro-accent-subtle);
  color: var(--pro-text-primary);
}

.sidebar-item .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sidebar-item .status-dot.connected { background: var(--pro-success); }
.sidebar-item .status-dot.disconnected { background: var(--pro-error); }
```

### Tabs
```css
.tab-bar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--pro-bg-page);
  border-bottom: 1px solid var(--pro-border-subtle);
  overflow-x: auto;
  scrollbar-width: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 36px;
  font-size: 12px;
  font-weight: 500;
  color: var(--pro-text-tertiary);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.tab:hover {
  background: var(--pro-bg-hover);
  color: var(--pro-text-secondary);
}

.tab.active {
  color: var(--pro-text-primary);
  border-bottom-color: var(--pro-accent);
  background: var(--pro-bg-panel);
}

.tab .close-btn {
  opacity: 0;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}

.tab:hover .close-btn,
.tab.active .close-btn {
  opacity: 1;
}

.tab .close-btn:hover {
  background: var(--pro-bg-hover);
}
```

### Toolbar
```css
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 12px;
  background: var(--pro-bg-page);
  border-bottom: 1px solid var(--pro-border-subtle);
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--pro-text-tertiary);
  cursor: pointer;
  transition: all 0.15s;
}

.toolbar-btn:hover {
  background: var(--pro-bg-hover);
  color: var(--pro-text-secondary);
}
```

### Status Bar
```css
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 12px;
  background: var(--pro-bg-page);
  border-top: 1px solid var(--pro-border-subtle);
  font-size: 11px;
  color: var(--pro-text-quaternary);
}

.status-bar-section {
  display: flex;
  align-items: center;
  gap: 12px;
}

.status-bar-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
```

### Panels
```css
.panel {
  display: flex;
  flex-direction: column;
  background: var(--pro-bg-panel);
  border: 1px solid var(--pro-border-standard);
  border-radius: 8px;
  overflow: hidden;
}

.panel.active {
  border-color: var(--pro-border-strong);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 8px;
  background: var(--pro-bg-card);
  border-bottom: 1px solid var(--pro-border-subtle);
}
```

---

## 6. New Features (v2.0)

### 6.1 Session Manager Sidebar
- **Host entries:** Each has: name, hostname:port, protocol, username, last connected, connection status
- **Groups:** Folders that can be collapsed/expanded, drag hosts between groups
- **Quick connect:** Type `user@host:port` in sidebar search to spawn a new SSH session
- **Import:** Parse `~/.ssh/config` to auto-populate hosts

### 6.2 Enhanced Tabs
- Tab states: loading (spinner), connected (green dot), error (red dot), idle (gray dot)
- Tab context menu: Rename, Duplicate, Move to panel, Close others, Close all
- Tab search: fuzzy-find across all open tabs

### 6.3 Status Bar
- Real-time connection status
- Cursor position (row/col) — read from xterm.js
- Shell type detection (bash/zsh/fish/pwsh)
- Data transfer counters (bytes in/out)
- Encoding indicator (UTF-8)
- Bell toggle

### 6.4 Command Palette Enhancement
- `Ctrl+Shift+P` opens command palette
- Commands: Connect to host, Open snippet, Toggle sidebar, Split panel, Change theme, etc.
- Fuzzy search across all commands

### 6.5 Snippets Panel
- Save frequently-used commands
- Variables: `{host}`, `{user}`, `{port}` that resolve at runtime
- Drag snippet to terminal to paste
- Search/filter snippets

---

## 7. Skin System Integration

### New Skin: `"pro"` (default for v2)
Add to `headerSkins.js`:
```javascript
{
  id: "pro",
  label: "Pro — Linear-inspired dark",
  description: "Clean, precise, modern. Inspired by Linear and Termius.",
  xterm: {
    background: "#08090a",
    foreground: "#b4b8c0",
    cursor: "#5e6ad2",
    selectionBackground: "rgba(94,106,210,0.3)",
    // ANSI colors tuned for the pro palette
    black: "#1a1a1b", red: "#ef4444", green: "#10b981", yellow: "#f59e0b",
    blue: "#5e6ad2", magenta: "#a78bfa", cyan: "#22d3ee", white: "#b4b8c0",
    brightBlack: "#4b4b4d", brightRed: "#f87171", brightGreen: "#34d399",
    brightYellow: "#fbbf24", brightBlue: "#828fff", brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9", brightWhite: "#f7f8f8",
  },
}
```

Add CSS variables:
```css
[data-phn-skin="pro"] {
  --phn-page-bg: #08090a;
  --phn-surface-bg: #0f1011;
  --phn-surface-alt-bg: #141516;
  --phn-surface-border: rgba(255,255,255,0.06);
  --phn-text-fg: #8a8f98;
  --phn-text-active: #f7f8f8;
  --phn-text-dim: #62666d;
  --phn-link: #828fff;
}
```

### New Skin: `"warm-pro"`
Warp-inspired warm dark variant with the same layout.

---

## 8. Files to Modify / Create

### Modify
| File | Changes |
|------|---------|
| `src/features/terminals/headerSkins.js` | Add "pro" and "warm-pro" skins with new CSS variable rules for sidebar, tabs, toolbar, status bar |
| `src/features/terminals/TerminalsTab.jsx` | Integrate new sidebar, toolbar, tab bar, status bar components; update layout grid |
| `src/features/terminals/TerminalPanel.jsx` | Add panel chrome (header with tabs), remove old inline styles |
| `src/features/terminals/TerminalPane.jsx` | Minor: ensure it fills new panel layout properly |
| `src/features/terminals/terminals.css` | Add new CSS for tabs, sidebar, toolbar, status bar, panels |
| `src/App.jsx` | Update layout shell to include sidebar + status bar |

### Create
| File | Purpose |
|------|---------|
| `src/features/terminals/Sidebar.jsx` | Collapsible left sidebar with Hosts/Keychain/Snippets sections |
| `src/features/terminals/SidebarSection.jsx` | Reusable collapsible accordion section |
| `src/features/terminals/HostTree.jsx` | Tree view of host groups and entries |
| `src/features/terminals/TabBar.jsx` | Panel-level tab bar with active state and close buttons |
| `src/features/terminals/StatusBar.jsx` | Bottom status bar component |
| `src/features/terminals/Toolbar.jsx` | Panel toolbar with controls |
| `src/features/terminals/useSidebar.js` | Hook for sidebar collapsed state, section expansion |
| `src/features/terminals/useStatusBar.js` | Hook for status bar data (cursor pos, connection state) |

---

## 9. Migration Notes

- **Backward compat:** Keep all existing skins (default, neon, magenta, crt, linear, brutal, glass, sunset, amber, daylight). The "pro" skin is additive.
- **State shape:** `terminalsState` may need a new `sidebar` sub-object for host groups, snippets, etc. Store in localStorage under existing key.
- **Projects sidebar:** The existing `ProjectSidebar.jsx` can be **moved into** the new left sidebar as one section, or deprecated in favor of Hosts.
- **Grid modes:** Existing grid.js logic (auto, 1-col, 2-col, etc.) continues to work. The new layout wraps the grid.

---

## 10. Rollout Plan

### Phase 1: Skin + CSS Foundation
1. Add "pro" skin to `headerSkins.js` with full CSS variable set
2. Create `terminals.css` additions for tabs, sidebar, toolbar, status bar
3. Verify existing functionality unchanged when "pro" skin is selected

### Phase 2: Layout Shell
1. Create `Sidebar.jsx`, `TabBar.jsx`, `Toolbar.jsx`, `StatusBar.jsx`
2. Update `TerminalsTab.jsx` to render new layout shell around existing grid
3. Wire up collapse/expand interactions

### Phase 3: Host Manager (MVP)
1. Create `HostTree.jsx` with hardcoded sample hosts + groups
2. Add import from `~/.ssh/config` via Tauri command
3. Connect double-click host → spawn new terminal tab

### Phase 4: Polish
1. Status bar: cursor position, connection status, encoding
2. Snippets panel: hardcoded sample snippets
3. Command palette: add host/snippet commands
4. Accessibility: keyboard nav in sidebar, aria labels

---

*End of spec. Ready for Claude Code execution.*
