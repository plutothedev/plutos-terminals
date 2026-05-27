# Claude Code — Pluto's Terminals Reskin v2.0

> **Paste this entire file into Claude Code as your prompt.**
> It contains the full design spec, exact CSS values, component architecture, and file-by-file implementation steps.
> **Do NOT summarize or shorten — Claude Code needs every detail.**

---

## Your Goal

Reskin Pluto's Terminals to look and feel like a professional terminal emulator (Termius + WindTerm + MobaXterm) with a Linear-inspired dark visual system. The existing codebase is a Tauri 2 + React 18 + Vite + xterm.js app. It already has a working multi-panel terminal grid, PTY backend, themes, and skins. Your job is to **add** the new "Pro" skin and new layout components (sidebar, tab bar, toolbar, status bar) **without breaking existing functionality**.

---

## Project Context

**Stack:** Tauri 2.10.3, React 18, Vite 8, xterm.js 5.5, portable-pty 0.8 (Rust)
**Repo:** `C:\Users\pluto\plutos-terminals` (or wherever the user cloned it)
**Existing skin system:** `data-phn-skin` global attribute on `<html>` drives CSS. `headerSkins.js` defines skins + xterm themes + per-skin CSS rules. `terminals.css` has animations.
**Existing layout:** `TerminalsTab.jsx` renders a grid of `TerminalPanel` components. Each `TerminalPanel` holds tabs and renders `TerminalPane` (xterm.js). `App.jsx` is the shell.

---

## Design System — "Pro" Skin

### Color Palette (EXACT VALUES — use these verbatim)

```css
/* Backgrounds */
--pro-bg-deep: #010102;
--pro-bg-page: #08090a;
--pro-bg-panel: #0f1011;
--pro-bg-card: #141516;
--pro-bg-hover: #1a1a1b;
--pro-bg-input: rgba(255,255,255,0.03);

/* Text */
--pro-text-primary: #f7f8f8;
--pro-text-secondary: #b4b8c0;
--pro-text-tertiary: #8a8f98;
--pro-text-quaternary: #62666d;
--pro-text-link: #828fff;

/* Accent */
--pro-accent: #5e6ad2;
--pro-accent-hover: #828fff;
--pro-accent-subtle: rgba(94,106,210,0.15);
--pro-success: #10b981;
--pro-warning: #f59e0b;
--pro-error: #ef4444;

/* Borders */
--pro-border-subtle: rgba(255,255,255,0.04);
--pro-border-standard: rgba(255,255,255,0.06);
--pro-border-strong: rgba(255,255,255,0.10);
```

### Typography (EXACT VALUES)

```css
--font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
```

| Role | Size | Weight | Line Height | Letter Spacing | Transform |
|------|------|--------|-------------|----------------|-----------|
| Section header | 11px | 600 | 1.2 | 0.06em | uppercase |
| Sidebar item | 13px | 400 | 1.4 | 0 | none |
| Sidebar item active | 13px | 500 | 1.4 | 0 | none |
| Tab label | 12px | 500 | 1.2 | 0.01em | none |
| Toolbar button | 12px | 500 | 1.2 | 0 | none |
| Status bar | 11px | 400 | 1.2 | 0.01em | none |

### xterm.js Theme for "Pro"

```javascript
{
  background: "#08090a",
  foreground: "#b4b8c0",
  cursor: "#5e6ad2",
  selectionBackground: "rgba(94,106,210,0.3)",
  black: "#1a1a1b", red: "#ef4444", green: "#10b981", yellow: "#f59e0b",
  blue: "#5e6ad2", magenta: "#a78bfa", cyan: "#22d3ee", white: "#b4b8c0",
  brightBlack: "#4b4b4d", brightRed: "#f87171", brightGreen: "#34d399",
  brightYellow: "#fbbf24", brightBlue: "#828fff", brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9", brightWhite: "#f7f8f8",
}
```

---

## New Components to Build

### 1. `Sidebar.jsx`
- **Props:** `collapsed`, `onToggle`, `hosts`, `snippets`, `activeHostId`, `onHostSelect`, `onSnippetSelect`
- **Layout:** Fixed-width left panel (240px, collapses to 48px). Vertical flex.
- **Sections:** Hosts (tree), Snippets (list). Each is a collapsible accordion.
- **Header:** App logo + name when expanded, just icon when collapsed. Toggle button (≡).
- **Styling:** `background: var(--pro-bg-page)`, `border-right: 1px solid var(--pro-border-subtle)`.
- **Collapsed state:** Show only section icons vertically centered. Tooltip on hover.

### 2. `SidebarSection.jsx`
- **Props:** `title`, `icon`, `expanded`, `onToggle`, `children`, `badgeCount`
- **Header:** 11px uppercase, letter-spacing 0.06em, color `--pro-text-tertiary`. Chevron rotates on toggle.
- **Content:** Padded 4px horizontal, 4px vertical gap between items.

### 3. `HostTree.jsx`
- **Props:** `groups`, `hosts`, `activeHostId`, `onSelect`, `onConnect`
- **Tree rendering:** Groups are collapsible folders. Hosts are leaf items.
- **Host item:** Status dot (6px circle, green `#10b981` = connected, red `#ef4444` = disconnected), name in `--pro-text-secondary`, protocol icon (SSH 🔐, local 💻), hover → `--pro-bg-hover`, active → `--pro-accent-subtle` bg + `--pro-text-primary`.
- **Double-click host:** Calls `onConnect(host)`.

### 4. `TabBar.jsx`
- **Props:** `tabs`, `activeTabId`, `onSelect`, `onClose`, `onNewTab`
- **Layout:** Horizontal flex, height 36px, `background: var(--pro-bg-page)`, `border-bottom: 1px solid var(--pro-border-subtle)`.
- **Tab:** `padding: 0 12px`, `height: 36px`, `font-size: 12px`, `font-weight: 500`, `color: var(--pro-text-tertiary)`, `border-bottom: 2px solid transparent`.
- **Active tab:** `color: var(--pro-text-primary)`, `border-bottom-color: var(--pro-accent)`, `background: var(--pro-bg-panel)`.
- **Close button:** 14px × 14px, opacity 0 → 1 on hover, centered × icon, hover bg `var(--pro-bg-hover)`.
- **New tab button:** + icon at right, 28px × 28px, `border-radius: 6px`, hover `var(--pro-bg-hover)`.
- **Overflow:** `overflow-x: auto`, `scrollbar-width: none`.

### 5. `Toolbar.jsx`
- **Props:** `onSplit`, `onSearch`, `onMenu`
- **Layout:** Height 40px, `padding: 0 12px`, flex row, `justify-content: space-between`.
- **Left:** Panel label or empty.
- **Right:** Toolbar buttons (28px × 28px, `border-radius: 6px`, `color: var(--pro-text-tertiary)`, hover `var(--pro-bg-hover)` + `var(--pro-text-secondary)`). Icons: split panel (⧉), search in terminal (🔍), panel menu (⋮).

### 6. `StatusBar.jsx`
- **Props:** `connectionStatus`, `hostName`, `encoding`, `cursorRow`, `cursorCol`, `shellType`, `bytesIn`, `bytesOut`
- **Layout:** Height 28px, `padding: 0 12px`, flex row, `justify-content: space-between`.
- **Background:** `var(--pro-bg-page)`, `border-top: 1px solid var(--pro-border-subtle)`, `font-size: 11px`, `color: var(--pro-text-quaternary)`.
- **Left section:** Status dot + "Connected" / "Disconnected" + host name.
- **Center:** Encoding + "Ln X, Col Y" + shell type.
- **Right:** Data transferred (human-readable, e.g. "1.2MB").

### 7. `PanelChrome.jsx` (wraps TerminalPanel)
- **Layout:** `display: flex`, `flex-direction: column`, `background: var(--pro-bg-panel)`, `border: 1px solid var(--pro-border-standard)`, `border-radius: 8px`, `overflow: hidden`.
- **Active state:** `border-color: var(--pro-border-strong)`.
- **Children:** `<TabBar />` + `<div className="panel-body">{terminal}</div>`.
- **Panel body:** `flex: 1`, `overflow: hidden`, `position: relative`.

---

## Files to Modify

### `src/features/terminals/headerSkins.js`

Add a new skin object to `HEADER_SKINS` array:

```javascript
{
  id: "pro",
  label: "Pro — Linear-inspired dark",
  description: "Clean, precise, modern. Professional terminal emulator aesthetic.",
  xterm: {
    background: "#08090a",
    foreground: "#b4b8c0",
    cursor: "#5e6ad2",
    selectionBackground: "rgba(94,106,210,0.3)",
    black: "#1a1a1b", red: "#ef4444", green: "#10b981", yellow: "#f59e0b",
    blue: "#5e6ad2", magenta: "#a78bfa", cyan: "#22d3ee", white: "#b4b8c0",
    brightBlack: "#4b4b4d", brightRed: "#f87171", brightGreen: "#34d399",
    brightYellow: "#fbbf24", brightBlue: "#828fff", brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9", brightWhite: "#f7f8f8",
  },
}
```

Add CSS variables block before the closing `\`\`\`` of the injected CSS string:

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

[data-phn-skin="pro"] .phn-header {
  background: #08090a;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

[data-phn-skin="pro"] .phn-title {
  color: #f7f8f8;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 13px;
}

[data-phn-skin="pro"] .phn-meta { color: #8a8f98; }

[data-phn-skin="pro"] .phn-btn,
[data-phn-skin="pro"] .phn-select {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  color: #b4b8c0;
  border-radius: 6px;
}

[data-phn-skin="pro"] .phn-btn:hover:not(:disabled),
[data-phn-skin="pro"] .phn-select:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.10);
  color: #f7f8f8;
}

[data-phn-skin="pro"] .phn-muted { color: #62666d !important; }
```

### `src/features/terminals/terminals.css`

Append the following CSS at the bottom of the file:

```css
/* ─────────────────────────────────────────────────────────────────────────────
   PRO SKIN — NEW COMPONENTS
   ───────────────────────────────────────────────────────────────────────────── */

/* Sidebar */
.pt-sidebar {
  display: flex;
  flex-direction: column;
  width: 240px;
  background: var(--phn-page-bg, #08090a);
  border-right: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  flex-shrink: 0;
  transition: width 0.2s ease;
  overflow: hidden;
}

.pt-sidebar.collapsed {
  width: 48px;
}

.pt-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  flex-shrink: 0;
}

.pt-sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--phn-text-fg, #8a8f98);
  cursor: pointer;
  transition: all 0.15s;
}

.pt-sidebar-toggle:hover {
  background: var(--phn-surface-bg, #0f1011);
  color: var(--phn-text-active, #f7f8f8);
}

.pt-sidebar-section {
  border-bottom: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  flex-shrink: 0;
}

.pt-sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--phn-text-dim, #62666d);
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}

.pt-sidebar-section-header:hover {
  color: var(--phn-text-fg, #8a8f98);
}

.pt-sidebar-section-content {
  padding: 0 4px 4px;
}

.pt-sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  font-size: 13px;
  color: var(--phn-text-fg, #8a8f98);
  cursor: pointer;
  border-radius: 4px;
  margin: 0 4px;
  transition: all 0.15s;
}

.pt-sidebar-item:hover {
  background: var(--phn-surface-bg, #0f1011);
  color: var(--phn-text-active, #f7f8f8);
}

.pt-sidebar-item.active {
  background: rgba(94,106,210,0.15);
  color: var(--phn-text-active, #f7f8f8);
}

.pt-sidebar-item .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.pt-sidebar-item .status-dot.connected { background: #10b981; }
.pt-sidebar-item .status-dot.disconnected { background: #ef4444; }

/* Tab Bar */
.pt-tab-bar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--phn-page-bg, #08090a);
  border-bottom: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  overflow-x: auto;
  scrollbar-width: none;
  flex-shrink: 0;
}

.pt-tab-bar::-webkit-scrollbar { display: none; }

.pt-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 36px;
  font-size: 12px;
  font-weight: 500;
  color: var(--phn-text-dim, #62666d);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
  user-select: none;
}

.pt-tab:hover {
  background: var(--phn-surface-bg, #0f1011);
  color: var(--phn-text-fg, #8a8f98);
}

.pt-tab.active {
  color: var(--phn-text-active, #f7f8f8);
  border-bottom-color: #5e6ad2;
  background: var(--phn-surface-alt-bg, #141516);
}

.pt-tab .pt-tab-close {
  opacity: 0;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 10px;
  line-height: 1;
}

.pt-tab:hover .pt-tab-close,
.pt-tab.active .pt-tab-close {
  opacity: 1;
}

.pt-tab .pt-tab-close:hover {
  background: var(--phn-surface-bg, #0f1011);
  color: var(--phn-text-active, #f7f8f8);
}

.pt-tab-new {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0 4px;
  border-radius: 6px;
  color: var(--phn-text-dim, #62666d);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}

.pt-tab-new:hover {
  background: var(--phn-surface-bg, #0f1011);
  color: var(--phn-text-fg, #8a8f98);
}

/* Toolbar */
.pt-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 12px;
  background: var(--phn-page-bg, #08090a);
  border-bottom: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  flex-shrink: 0;
}

.pt-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--phn-text-dim, #62666d);
  cursor: pointer;
  transition: all 0.15s;
  font-size: 12px;
}

.pt-toolbar-btn:hover {
  background: var(--phn-surface-bg, #0f1011);
  color: var(--phn-text-fg, #8a8f98);
}

/* Status Bar */
.pt-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 12px;
  background: var(--phn-page-bg, #08090a);
  border-top: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  font-size: 11px;
  color: var(--phn-text-dim, #62666d);
  flex-shrink: 0;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

.pt-status-bar-section {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pt-status-bar-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pt-status-bar-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.pt-status-bar-dot.connected { background: #10b981; }
.pt-status-bar-dot.disconnected { background: #ef4444; }

/* Panel Chrome */
.pt-panel {
  display: flex;
  flex-direction: column;
  background: var(--phn-surface-alt-bg, #141516);
  border: 1px solid var(--phn-surface-border, rgba(255,255,255,0.06));
  border-radius: 8px;
  overflow: hidden;
}

.pt-panel.active {
  border-color: rgba(255,255,255,0.10);
}

.pt-panel-body {
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* App Layout */
.pt-app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--phn-page-bg, #08090a);
}

.pt-app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.pt-app-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.pt-app-grid {
  display: grid;
  flex: 1;
  gap: 8px;
  padding: 8px;
  overflow: hidden;
}
```

### `src/features/terminals/TerminalsTab.jsx`

**Goal:** Wrap the existing terminal grid in the new layout shell (sidebar + status bar + panel chrome).

**Changes:**
1. Import new components:
   ```javascript
   import Sidebar from "./Sidebar.jsx";
   import StatusBar from "./StatusBar.jsx";
   import PanelChrome from "./PanelChrome.jsx";
   import TabBar from "./TabBar.jsx";
   ```

2. Add sidebar state:
   ```javascript
   const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
   const [sidebarSections, setSidebarSections] = useState({ hosts: true, snippets: false });
   ```

3. Add sample host data (for now):
   ```javascript
   const [hosts] = useState([
     {
       id: "local",
       name: "Local",
       hostname: "localhost",
       protocol: "local",
       status: "connected",
     },
     {
       id: "vps",
       name: "Pluto VPS",
       hostname: "pluto-vps.example.com",
       protocol: "ssh",
       user: "root",
       status: "disconnected",
     },
   ]);
   ```

4. Update the render layout. Keep the existing grid logic but wrap it:
   ```jsx
   <div className="pt-app-layout">
     <div className="pt-app-body">
       <Sidebar
         collapsed={sidebarCollapsed}
         onToggle={() => setSidebarCollapsed(c => !c)}
         hosts={hosts}
         sections={sidebarSections}
         onSectionToggle={(id) => setSidebarSections(s => ({ ...s, [id]: !s[id] }))}
       />
       <div className="pt-app-main">
         <div className="pt-app-grid" style={{ gridTemplateColumns: gridCols }}>
           {state.panels.map(panel => (
             <PanelChrome key={panel.id} active={panel.id === state.activePanelId}>
               <TabBar
                 tabs={panel.tabs}
                 activeTabId={panel.activeTabId}
                 onSelect={(tabId) => /* existing logic */}
                 onClose={(tabId) => /* existing logic */}
                 onNewTab={() => /* existing logic */}
               />
               {/* existing panel content rendering */}
             </PanelChrome>
           ))}
         </div>
       </div>
     </div>
     <StatusBar
       connectionStatus="connected"
       hostName="localhost"
       encoding="UTF-8"
       cursorRow={1}
       cursorCol={1}
       shellType="zsh"
       bytesIn={0}
       bytesOut={0}
     />
   </div>
   ```

5. **CRITICAL:** Keep ALL existing logic — state management, dialog handling, recording, command palette, etc. Only change the JSX layout structure.

### `src/App.jsx`

Remove the old page background inline styles and let the new `.pt-app-layout` handle it. The `AppInner` component should render `<TerminalsTab />` inside a `<div className="pt-app-layout">` or let `TerminalsTab` own the layout.

**Simplest approach:** Remove the outer `<div style={{ background: PAGE_BG, ... }}>` wrapper from `AppInner` and let `TerminalsTab` render `.pt-app-layout` as its root. The existing `<TerminalsTab st={st} save={save} ... />` call stays the same.

---

## Implementation Order

1. **Add "pro" skin to `headerSkins.js`** — this gives you the color system immediately. Test by selecting it in the app.
2. **Add CSS to `terminals.css`** — all the new component styles.
3. **Create `TabBar.jsx`** — simplest new component, high visual impact.
4. **Create `PanelChrome.jsx`** — wraps existing panel content.
5. **Update `TerminalsTab.jsx`** — integrate TabBar + PanelChrome into existing grid.
6. **Create `Sidebar.jsx` + `SidebarSection.jsx`** — left sidebar with sample data.
7. **Update `TerminalsTab.jsx`** — add Sidebar to layout.
8. **Create `StatusBar.jsx`** — bottom bar.
9. **Update `TerminalsTab.jsx`** — add StatusBar.
10. **Create `Toolbar.jsx`** — panel toolbar (optional, can skip for MVP).
11. **Polish:** Test all existing skins still work. Ensure "pro" skin is selectable. Verify keyboard shortcuts still function.

---

## Acceptance Criteria

- [ ] "Pro" skin appears in skin picker and applies correctly
- [ ] All existing skins (default, neon, magenta, crt, linear, brutal, glass, sunset, amber, daylight) still work
- [ ] Left sidebar renders with collapsible sections
- [ ] Tab bar renders per panel with active state and close buttons
- [ ] Status bar renders at bottom with sample data
- [ ] Panel chrome (border + radius) wraps each terminal panel
- [ ] Existing terminal functionality (typing, PTY, scrollback, themes) is unchanged
- [ ] Grid modes (auto, 1-col, 2-col, etc.) still work
- [ ] No console errors
- [ ] `cargo tauri dev` builds and runs successfully

---

## Reference: Target App Screenshots

Since you cannot browse the web, here are the key visual patterns to emulate:

**Termius:**
- Left sidebar: dark navy `#1a1d29`, 240px, collapsible to icons
- Sidebar sections: Hosts, Keychain, Snippets, Port Forwarding — each with 11px uppercase header
- Host items: 6px status dot (green/red), 13px name, protocol icon
- Tabs: bottom accent border on active, 36px height, close on hover
- Status bar: 28px, connection status left, cursor position center, data right

**WindTerm:**
- Session tree in sidebar with folder groups
- Top toolbar with connection buttons
- Bottom dock area for SFTP
- Generally denser UI than Termius

**MobaXterm:**
- Tabbed sessions with protocol icons
- Left sidebar with session types
- Status bar with session info
- Feature-rich but slightly dated — we take the density, not the visual style

**Linear (visual language):**
- `#08090a` backgrounds
- `rgba(255,255,255,0.06)` borders
- `#5e6ad2` accent
- Inter font, weight 500 emphasis
- Minimal, precise, no gradients

**Warp (warm variant inspiration):**
- Warm dark `#0f0f0e` background option
- Warm parchment `#faf9f6` text
- Earthy muted buttons
- Approachable feel

---

## Context Files to Read First

Before starting, read these files to understand the current codebase:

1. `src/features/terminals/TerminalsTab.jsx` — main layout, state, render logic
2. `src/features/terminals/TerminalPanel.jsx` — panel component (tabs + terminal)
3. `src/features/terminals/headerSkins.js` — skin system, CSS injection
4. `src/features/terminals/terminals.css` — existing CSS
5. `src/App.jsx` — app shell
6. `src/features/terminals/grid.js` — grid column logic

---

## Notes for Claude Code

- **Use `Read` tool** to inspect files before editing.
- **Use `Edit` tool** for targeted changes — do NOT rewrite entire files unless necessary.
- **Preserve existing logic:** The app has complex state for PTY sessions, scrollback, recording, command palette, etc. Only touch layout JSX and CSS.
- **Font loading:** Inter is already available via the existing font stack or Google Fonts. If not loaded, add:
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  ```
  to `index.html`.
- **Icons:** Use Unicode symbols or inline SVG strings. Do NOT add a new icon library dependency.
- **Build frequently:** Run `npm run tauri dev` after each major change to verify.
- **Commit often:** `git add -A && git commit -m "reskin: add Sidebar component"` etc.

---

*End of prompt. Paste this entire file into Claude Code and execute.*
