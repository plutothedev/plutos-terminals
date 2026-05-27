# Claude Code — Pluto's Terminals: Full UI Overhaul v3.0

> **Paste this ENTIRE file into Claude Code as your prompt. Do NOT summarize or shorten — Claude Code needs every detail.**
>
> **Goal:** Transform the entire app layout, chrome, and aesthetic to match professional terminal emulators (Termius + WindTerm + MobaXterm). This is NOT a skin — it's a full structural and visual overhaul.
>
> **Research basis:** `design/RESEARCH-TERMINAL-APPS.md` — in-depth analysis of Termius (modern SaaS), WindTerm (IDE-style), MobaXterm (classic toolbox).

---

## Your Goal

Restructure and restyle Pluto's Terminals into a professional terminal emulator with:

1. **Fixed left sidebar** (enhanced ProjectSidebar — searchable, collapsible, icon-enhanced)
2. **Thin top toolbar** (quick actions: new terminal, split, snippets toggle, settings)
3. **Clean top tab bar** (enhance existing TerminalPanel tabs — smaller, hover-close, activity dots)
4. **Edge-to-edge terminal area** (minimal chrome, subtle active panel indicator)
5. **Thin bottom status bar** (enhance existing — add pane count, active shell, terminal size)
6. **Right drawer: Snippets panel** (NEW feature — saved commands, click-to-insert)
7. **Complete visual overhaul** (new default "Pro" aesthetic: dark-first, minimal chrome, refined spacing)
8. **macOS build support** (bundle targets, MCP installer fix, docs)

**CRITICAL RULE:** Do NOT create parallel components. The codebase already has working tabs, sidebar, status bar, and toolbar. Your job is to **RESTYLE and ENHANCE** these existing components, not replace them with new ones.

---

## Current Codebase State (Verified)

| File | What It Does | Your Action |
|------|-------------|-------------|
| `src/App.jsx` | App shell, renders `<TerminalsTab>` directly | Add layout wrapper (sidebar + main area structure) |
| `src/features/terminals/TerminalsTab.jsx` | Main layout: header toolbar, grid of TerminalPanels, status bar | Restructure into: sidebar + toolbar + tabs + main grid + status bar |
| `src/features/terminals/TerminalPanel.jsx` | Renders tabs + TerminalPane per panel | Restyle tabs (smaller, cleaner, hover-close, activity dots). Keep all drag/rename/close logic. |
| `src/features/terminals/ProjectSidebar.jsx` | Project-based sidebar (21KB) | Restyle to look like Termius connection tree. Add search, section headers, icons, cleaner styling. |
| `src/features/terminals/terminals.css` | All terminal-related CSS | Append new layout + component styles. Keep existing animations. |
| `src/features/terminals/headerSkins.js` | Skin system (10 skins, --phn-* vars) | Add "pro" skin as the new default. Keep all existing skins. |
| `src/features/terminals/grid.js` | Grid layout calculations | Keep as-is, may need minor CSS adjustments |
| `src-tauri/tauri.conf.json` | Tauri config | Add "dmg", "app" to bundle targets |
| `src/components/McpInstaller.jsx` | MCP installer UI | Fix %USERPROFILE% to be platform-aware |

**Already exists and works — do NOT replace:**
- Tab drag-to-reorder, inline rename, close buttons, activity indicators (TerminalPanel)
- ProjectSidebar project tree, drag-drop, context menus
- .phn-statusbar with cost tracking, links
- Multi-panel grid system
- PTY backend, themes, multi-window, tray

---

## Target Design System — "Pro" Aesthetic

### Philosophy
Content-first, minimal chrome, edge-to-edge terminals. Inspired by Termius's "Slack for SSH" cleanliness + WindTerm's IDE density + MobaXterm's utility.

### Color Palette (EXACT VALUES)

```css
/* Backgrounds — deepest to lightest */
--pro-bg-deep:      #010102;
--pro-bg-page:      #08090a;
--pro-bg-sidebar:   #0c0d0e;
--pro-bg-panel:     #0f1011;
--pro-bg-card:      #141516;
--pro-bg-hover:     #1a1a1b;
--pro-bg-active:    #1e1f20;
--pro-bg-input:     rgba(255,255,255,0.03);
--pro-bg-border:    rgba(255,255,255,0.06);

/* Text */
--pro-text-primary:   #f7f8f8;
--pro-text-secondary: #b4b8c0;
--pro-text-tertiary:  #8a8f98;
--pro-text-quaternary:#62666d;
--pro-text-dim:       #4a4d54;
--pro-text-link:      #828fff;

/* Accent — Pluto magenta + pro blue blend */
--pro-accent:         #5e6ad2;
--pro-accent-hover:   #828fff;
--pro-accent-subtle:  rgba(94,106,210,0.15);
--pro-accent-glow:    rgba(94,106,210,0.08);

/* Status */
--pro-success:  #10b981;
--pro-warning:  #f59e0b;
--pro-error:    #ef4444;
--pro-info:     #3b82f6;

/* Terminal-specific */
--pro-term-bg:    #08090a;
--pro-term-border:rgba(255,255,255,0.04);
--pro-divider:    rgba(255,255,255,0.06);
```

### Typography
- UI font: system-ui, -apple-system, sans-serif (use `font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)
- Terminal font: JetBrains Mono or user's choice (keep existing)
- UI sizes: 11px labels, 12px body, 13px headings, 14px toolbar
- Line heights: 1.4 UI, 1.5 terminal

### Spacing
- Sidebar width: 240px (collapsible to 48px icon-rail)
- Toolbar height: 40px
- Tab bar height: 36px
- Status bar height: 28px
- Panel padding: 0px (edge-to-edge terminals)
- Border radius: 4px for buttons/cards, 0px for panels (sharp corners)

---

## Layout Architecture

The app window is divided into 5 zones:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [Toolbar: New ━ Split ━ Snippets ━ Settings ━ ───────────────────────────────────────────────────────────│
├───────────────────────────────────────────────────────────────────────────────┤
│ Sidebar    │ [Tab 1] [Tab 2] [Tab 3] [+]                                     │
│            │┌────────────────────────────────────────────────────────────────────────┤
│ Projects   ││ Terminal Panel 1                              │ Terminal Panel 2     │
│ ─────────── ││                                               │                      │
│ ▶ Project A││                                               │                      │
│ ▶ Project B││                                               │                      │
│            │└────────────────────────────────────────────────────────────────────────┘
│ [Search]   │                                                                   │
├───────────────────────────────────────────────────────────────────────────────┤
│ Shell: zsh │ Panes: 2 │ Size: 120×30 │ Cost: $0.042 │ Pluto's Terminals v0.1.33 │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation — File by File

### 1. `src/App.jsx` — Add Layout Wrapper

**Current:** `AppInner` renders `<TerminalsTab>` directly with no outer layout structure.

**Change:** Wrap `TerminalsTab` in a new top-level layout container that provides the full window structure.

```jsx
// New: AppLayout component (can live in App.jsx or new file)
function AppLayout({ children }) {
  return (
    <div className="pt-app-layout" data-phn-skin={st.skin}>
      {children}
    </div>
  );
}

// In AppInner:
<AppLayout>
  <TerminalsTab st={st} save={save} ... />
</AppLayout>
```

The `.pt-app-layout` class handles: `display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; background: var(--pro-bg-page);`

---

### 2. `src/features/terminals/TerminalsTab.jsx` — Full Restructure

**Current structure:** Header toolbar → Grid of TerminalPanels → Status bar

**New structure:** Sidebar + MainArea (Toolbar + Tabs + Grid + StatusBar)

Restructure the render to:

```jsx
<div className="pt-main-container">
  <ProjectSidebar 
    // existing props
    className="pt-sidebar"
  />
  <div className="pt-main-area">
    <Toolbar 
      onNewTerminal={...}
      onSplit={...}
      onToggleSnippets={...}
      onSettings={...}
    />
    {/* Tab bar is INSIDE TerminalPanel — keep it there, just restyle */}
    <div className="pt-grid-container">
      {/* existing grid of TerminalPanels */}
    </div>
    <StatusBar 
      // existing props + new ones
    />
  </div>
  <SnippetsDrawer 
    open={snippetsOpen}
    onClose={...}
    onInsert={...}
  />
</div>
```

**CRITICAL:** Do NOT remove the existing grid logic, panel management, or PTY session handling. Only restructure the DOM/layout. The `pt-grid-container` should be the existing grid container with all its event handlers.

The sidebar should be collapsible: add a toggle button that collapses it to 48px (showing only project icons). Use CSS transitions for smooth width change.

---

### 3. `src/features/terminals/ProjectSidebar.jsx` — Restyle to Termius-Style

**Current:** Functional but basic styling. 21KB of logic — keep ALL of it.

**Restyle:**
- Add a **search bar** at the top of the sidebar (filter projects by name)
- Add **section headers** with expand/collapse: "Projects", "Quick Access", "Recent"
- Style the tree items like Termius connection entries:
  - Each project: icon (folder) + name + status dot (green if PTY active, gray if idle)
  - Hover: `--pro-bg-hover` background
  - Active/selected: `--pro-bg-active` + left 2px accent border
  - Expand/collapse chevrons on the right
- Add a **"New Project"** button at the bottom of the sidebar
- Collapsible: add a `collapsed` prop. When collapsed, show only icons in a 48px rail.
- Use the Pro color palette. No more bright colors — all muted except the accent.

**CSS classes to add:** `.pt-sidebar`, `.pt-sidebar-search`, `.pt-sidebar-section`, `.pt-sidebar-item`, `.pt-sidebar-item-active`, `.pt-sidebar-collapsed`

---

### 4. `src/features/terminals/TerminalPanel.jsx` — Restyle Tabs

**Current:** Full tab strip with drag, rename, close, activity indicators — all functional.

**Restyle tabs to be cleaner:**
- **Height:** Reduce from current to 36px
- **Background:** `--pro-bg-panel`
- **Active tab:** `--pro-bg-card` background, bottom 2px accent border (`--pro-accent`)
- **Inactive tab:** transparent, `--pro-text-tertiary` text
- **Hover:** `--pro-bg-hover` background
- **Close button:** Appear on hover only (Termius style), × icon, `--pro-text-quaternary`, hover `--pro-error`
- **Activity dot:** Small 6px dot on the right side of the tab (green for active PTY, gray for idle)
- **Rename:** Keep inline rename on double-click, but style input with `--pro-bg-input`
- **New tab button:** + icon at the end of the tab strip, `--pro-text-tertiary`, hover `--pro-accent`
- **Drag ghost:** Style the dragged tab with a subtle shadow and `--pro-bg-card`

The tab bar itself: `border-bottom: 1px solid var(--pro-divider)`

---

### 5. `src/features/terminals/terminals.css` — Append New Styles

Add these new CSS sections (keep all existing styles):

```css
/* === PRO LAYOUT === */
.pt-app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--pro-bg-page);
  color: var(--pro-text-primary);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
}

.pt-main-container {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.pt-sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--pro-bg-sidebar);
  border-right: 1px solid var(--pro-divider);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease, min-width 0.2s ease;
}

.pt-sidebar-collapsed {
  width: 48px;
  min-width: 48px;
}

.pt-main-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.pt-toolbar {
  height: 40px;
  background: var(--pro-bg-panel);
  border-bottom: 1px solid var(--pro-divider);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 8px;
  flex-shrink: 0;
}

.pt-toolbar-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--pro-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.pt-toolbar-btn:hover {
  background: var(--pro-bg-hover);
  color: var(--pro-text-primary);
}

.pt-toolbar-btn:active {
  background: var(--pro-bg-active);
}

.pt-grid-container {
  flex: 1;
  overflow: hidden;
  background: var(--pro-bg-deep);
}

.pt-statusbar {
  height: 28px;
  background: var(--pro-bg-panel);
  border-top: 1px solid var(--pro-divider);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 16px;
  font-size: 11px;
  color: var(--pro-text-tertiary);
  flex-shrink: 0;
}

.pt-statusbar-section {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pt-statusbar-label {
  color: var(--pro-text-quaternary);
}

.pt-statusbar-value {
  color: var(--pro-text-secondary);
  font-weight: 500;
}

/* === SNIPPETS DRAWER === */
.pt-snippets-drawer {
  position: fixed;
  top: 40px; /* below toolbar */
  right: 0;
  bottom: 28px; /* above statusbar */
  width: 320px;
  background: var(--pro-bg-sidebar);
  border-left: 1px solid var(--pro-divider);
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.2s ease;
  z-index: 100;
}

.pt-snippets-drawer.open {
  transform: translateX(0);
}

.pt-snippets-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--pro-divider);
  font-size: 13px;
  font-weight: 600;
  color: var(--pro-text-primary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.pt-snippets-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.pt-snippet-item {
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 4px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.pt-snippet-item:hover {
  background: var(--pro-bg-hover);
}

.pt-snippet-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--pro-text-primary);
  margin-bottom: 2px;
}

.pt-snippet-command {
  font-size: 11px;
  color: var(--pro-text-tertiary);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* === TERMINAL PANEL CHROME === */
.pt-panel {
  background: var(--pro-term-bg);
  border: 1px solid var(--pro-term-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pt-panel.active {
  border-color: var(--pro-accent);
  box-shadow: 0 0 0 1px var(--pro-accent-glow);
}

.pt-panel-header {
  height: 36px;
  background: var(--pro-bg-panel);
  border-bottom: 1px solid var(--pro-divider);
  display: flex;
  align-items: center;
  padding: 0 8px;
}

.pt-panel-tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  gap: 2px;
}

.pt-panel-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 36px;
  border-radius: 0;
  border: none;
  background: transparent;
  color: var(--pro-text-tertiary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  position: relative;
  transition: all 0.15s ease;
}

.pt-panel-tab:hover {
  background: var(--pro-bg-hover);
  color: var(--pro-text-secondary);
}

.pt-panel-tab.active {
  background: var(--pro-bg-card);
  color: var(--pro-text-primary);
  border-bottom: 2px solid var(--pro-accent);
}

.pt-panel-tab .tab-close {
  opacity: 0;
  transition: opacity 0.15s ease;
  margin-left: 4px;
}

.pt-panel-tab:hover .tab-close {
  opacity: 1;
}

.pt-panel-tab .tab-activity {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pro-success);
  flex-shrink: 0;
}

.pt-panel-tab .tab-activity.idle {
  background: var(--pro-text-quaternary);
}

.pt-panel-content {
  flex: 1;
  overflow: hidden;
}

/* === DIVIDERS === */
.pt-divider-vertical {
  width: 4px;
  background: transparent;
  cursor: col-resize;
  position: relative;
}

.pt-divider-vertical:hover::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 1px;
  width: 2px;
  background: var(--pro-accent);
}

.pt-divider-horizontal {
  height: 4px;
  background: transparent;
  cursor: row-resize;
  position: relative;
}

.pt-divider-horizontal:hover::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 1px;
  height: 2px;
  background: var(--pro-accent);
}
```

---

### 6. New Component: `src/features/terminals/SnippetsDrawer.jsx`

A right-side drawer for saved command snippets (like Termius snippets).

**Data model:** Hardcode a default set of snippets in the component for now. Later can be made configurable.

```jsx
const DEFAULT_SNIPPETS = [
  { id: '1', name: 'Git status', command: 'git status' },
  { id: '2', name: 'Git log', command: 'git log --oneline -20' },
  { id: '3', name: 'List files', command: 'ls -la' },
  { id: '4', name: 'Current dir', command: 'pwd' },
  { id: '5', name: 'Node version', command: 'node -v && npm -v' },
  { id: '6', name: 'Disk usage', command: 'du -sh * | sort -h' },
  { id: '7', name: 'Find process', command: 'ps aux | grep ' },
  { id: '8', name: 'Clear screen', command: 'clear' },
];
```

**Props:** `open`, `onClose`, `onInsert(command)`

**Behavior:**
- Click a snippet → calls `onInsert(command)` → the parent writes the command into the ACTIVE terminal's PTY input
- Search/filter snippets by name
- Close button (X) in header
- Open/close via toolbar button

**To insert into a terminal:** You'll need to pass the `onInsert` callback up to `TerminalsTab`, which finds the active `TerminalPane` and calls its `pty_write` equivalent (or exposes a ref). If this is too complex for this session, make the drawer UI-only (visual placeholder) and note it as "functional wiring needed."

---

### 7. New Component: `src/features/terminals/Toolbar.jsx`

Thin top toolbar. Props: `onNewTerminal`, `onSplitHorizontal`, `onSplitVertical`, `onToggleSnippets`, `onSettings`

```jsx
function Toolbar({ onNewTerminal, onSplitHorizontal, onSplitVertical, onToggleSnippets, onSettings }) {
  return (
    <div className="pt-toolbar">
      <button className="pt-toolbar-btn" onClick={onNewTerminal} title="New Terminal">
        <span>+</span> New
      </button>
      <div className="pt-toolbar-divider" />
      <button className="pt-toolbar-btn" onClick={onSplitHorizontal} title="Split Horizontal">
        ━ Split ━
      </button>
      <button className="pt-toolbar-btn" onClick={onSplitVertical} title="Split Vertical">
        │ Split │
      </button>
      <div className="pt-toolbar-divider" />
      <button className="pt-toolbar-btn" onClick={onToggleSnippets} title="Snippets">
        {}
        Snippets
      </button>
      <div style={{ flex: 1 }} />
      <button className="pt-toolbar-btn" onClick={onSettings} title="Settings">
        ⚙️
      </button>
    </div>
  );
}
```

**CSS for divider:**
```css
.pt-toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--pro-divider);
}
```

---

### 8. `src/features/terminals/headerSkins.js` — Add "pro" Skin

Add the "pro" skin as the new default. Keep ALL existing skins.

The skin should define:
- xterm.js theme colors matching the Pro palette
- CSS variable overrides for the app chrome

The skin system uses `--phn-*` variables. Map the Pro palette to these:

```javascript
{
  id: 'pro',
  name: 'Pro',
  description: 'Professional dark terminal inspired by Termius and WindTerm',
  xterm: {
    foreground: '#f7f8f8',
    background: '#08090a',
    cursor: '#828fff',
    selectionBackground: 'rgba(94,106,210,0.25)',
    black: '#1a1a1b',
    red: '#ef4444',
    green: '#10b981',
    yellow: '#f59e0b',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#f7f8f8',
    brightBlack: '#4a4d54',
    brightRed: '#f87171',
    brightGreen: '#34d399',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff',
  },
  vars: {
    // Map Pro palette to --phn-* variables used by the skin system
    '--phn-page-bg': '#08090a',
    '--phn-header-bg': '#0f1011',
    '--phn-header-border': 'rgba(255,255,255,0.06)',
    '--phn-sidebar-bg': '#0c0d0e',
    '--phn-panel-bg': '#0f1011',
    '--phn-card-bg': '#141516',
    '--phn-hover-bg': '#1a1a1b',
    '--phn-active-bg': '#1e1f20',
    '--phn-text-primary': '#f7f8f8',
    '--phn-text-secondary': '#b4b8c0',
    '--phn-text-tertiary': '#8a8f98',
    '--phn-text-dim': '#62666d',
    '--phn-accent': '#5e6ad2',
    '--phn-accent-hover': '#828fff',
    '--phn-accent-subtle': 'rgba(94,106,210,0.15)',
    '--phn-border': 'rgba(255,255,255,0.06)',
    '--phn-divider': 'rgba(255,255,255,0.06)',
    '--phn-success': '#10b981',
    '--phn-warning': '#f59e0b',
    '--phn-error': '#ef4444',
  }
}
```

Also update the DEFAULT skin to "pro" (or keep it as a user preference but make "pro" the default).

---

### 9. `src-tauri/tauri.conf.json` — macOS Bundle Targets

```json
"targets": ["msi", "dmg", "app"]
```

---

### 10. `src/components/McpInstaller.jsx` — Platform-Aware Home Path

Line ~83:
```javascript
const isWindows = navigator.userAgent.includes("Windows");
const homeVar = isWindows ? "%USERPROFILE%" : "$HOME";
let cmd = mcp.command.replace(/\$\{PWD\}/g, homeVar);
```

---

### 11. Prompt-Pack Docs — Add `${HOME}`

Update `prompt-packs/HOW_TO_USE.md`, `prompt-packs/README.md`, and root `README.md` to mention:
```markdown
- `${USERPROFILE}` — Windows home directory
- `${HOME}` — macOS / Linux home directory
```

---

## What NOT to Do

| Don't | Why |
|-------|-----|
| Create a parallel `TabBar.jsx` | TerminalPanel already has working tabs with drag/rename/close |
| Create a parallel `StatusBar.jsx` | `.phn-statusbar` already exists with cost tracking |
| Create a parallel `Sidebar.jsx` | `ProjectSidebar.jsx` already exists with full project tree logic |
| Remove existing skin system | 10 skins exist; add "pro" as #11 |
| Break PTY/session logic | The core terminal functionality must keep working |
| Change grid.js logic | Grid calculations work; only CSS needs updating |
| Remove existing animations | `terminals.css` has working animations; append new styles |

---

## Implementation Order

1. **Add "pro" skin to `headerSkins.js`** — immediate visual impact
2. **Append new CSS to `terminals.css`** — all the layout + component styles
3. **Restructure `TerminalsTab.jsx`** — sidebar + main area layout
4. **Restyle `ProjectSidebar.jsx`** — Termius-style tree
5. **Restyle tabs in `TerminalPanel.jsx`** — cleaner tab bar
6. **Create `Toolbar.jsx`** — new top toolbar
7. **Create `SnippetsDrawer.jsx`** — right drawer (UI-first, wire later if needed)
8. **Update `App.jsx`** — add layout wrapper
9. **macOS fixes** — `tauri.conf.json`, `McpInstaller.jsx`, docs
10. **Test dev mode**

---

## Acceptance Criteria

- [ ] App boots in `npm run tauri dev` with no errors
- [ ] "Pro" skin is selectable and applies the new dark aesthetic
- [ ] Left sidebar is visible, searchable, and collapsible to icon-rail
- [ ] Top toolbar has: New, Split H, Split V, Snippets, Settings buttons
- [ ] Tab bar is cleaner: smaller height, hover-close, activity dots, accent underline on active
- [ ] Terminal panels are edge-to-edge with subtle borders
- [ ] Active panel has accent border highlight
- [ ] Bottom status bar shows: shell type, pane count, terminal size, cost
- [ ] Snippets drawer opens/closes from toolbar button
- [ ] All existing functionality works: new tab, close tab, drag tabs, rename tabs, split panels, themes switch, project sidebar open/close, PTY sessions
- [ ] macOS: `npm run tauri build` produces `.dmg`

---

## If You Hit Issues

- **ProjectSidebar is 21KB — too big to restyle all at once?** Focus on the outer container styles and tree item styles first. Don't rewrite the logic.
- **Snippets drawer can't wire to PTY?** Build the UI anyway. Make it a visual placeholder with a TODO comment. Functionality can be wired in a follow-up.
- **Tab restyling breaks drag/rename?** Only change CSS classes and visual properties. Keep all event handlers and state logic exactly as-is.
- **Layout feels cramped?** Increase sidebar width to 260px or reduce toolbar height to 36px. Tweak the CSS variables.
