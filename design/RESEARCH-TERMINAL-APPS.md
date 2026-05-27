# Terminal Emulator UI/UX Research: Termius, WindTerm, MobaXterm

> Research conducted for Pluto's Terminals full UI overhaul.
> Goal: Understand the common patterns, layouts, and aesthetics of professional terminal emulators to redesign Pluto's Terminals.

---

## 1. TERMIUS

### Overall Window Layout
- **Three-zone layout**: narrow left sidebar → main terminal area → optional right/bottom panels
- Chrome is minimal; terminal content dominates (content-first philosophy)
- Title bar is native OS style; on macOS it feels like a native Cocoa app
- No heavy borders or 3D chrome; flat design

### Sidebar Content and Structure
- **Left sidebar (~220px)**: collapsible, hosts the connection library
  - **Header**: Account/team switcher (for Pro), search bar, "+ New Host" button
  - **Body**: Hierarchical tree of connections organized into folders/tags
    - Each host shows: alias/name, connection indicator (colored dot), and protocol icon
    - Groups can be expanded/collapsed; favorites section at top; tags for filtering
  - **Bottom of sidebar**: Team/shared hosts indicator, sync status
- Sidebar can be hidden entirely with a toggle or keyboard shortcut

### Tab System
- **Top tabs** (macOS-style or inline depending on platform)
  - Tab shows: connection alias, protocol icon, live connection status dot
  - Close button appears on hover (clean look)
  - Tabs can be reordered via drag-and-drop
- Tab bar is relatively short in height (~32px), preserving vertical space

### Terminal Panel Chrome
- **Minimal chrome**: terminal surface goes nearly edge-to-edge within its tab container
- Thin 1px divider between sidebar and terminal (subtle gray)
- No heavy panel headers inside the tab — the tab itself carries the identity
- On split views, a draggable 4px divider with a subtle grip indicator

### Status Bar Content and Placement
- **Bottom status bar** (~24px, subtle)
  - Connection status, latency/ping indicator, local/remote IP and port
  - Terminal size (cols × rows), active encryption indicator (lock icon)
  - VPN/port-forward status if active
- Styled in muted gray; does not compete visually with terminal content

### Toolbar / Button Bar Placement and Contents
- **Top toolbar** (thin, ~40px) below title bar / above tabs
  - Quick-connect search field (prominent)
  - "+" new host / new terminal buttons
  - Snippets button, port forwarding toggle, SFTP toggle (opens side panel)
  - Settings / preferences gear
- Icon-only buttons with tooltips; no text labels to save space

### Color Scheme and Visual Style
- **Default**: polished dark theme (near-black #0d0d0d or deep navy-gray)
- **Light theme**: available but less commonly used
- Accent colors: signature **teal/cyan** brand color for highlights, active states, and connection dots
- Typography: system-native sans-serif; terminal uses user's chosen mono font
- **Aesthetic**: "Slack for SSH" — modern SaaS-app feel, very clean, generous whitespace, rounded corners, native-feeling transitions
- Strong cross-platform consistency (mobile apps share the same design language)

### Bottom or Side Panels (SFTP, File Manager, Logs, etc.)
- **SFTP Panel**: opens as a right-side drawer (~300px) or bottom panel
  - Split view: local file system on left, remote on right
  - Drag-and-drop between panes; file transfer queue at bottom of panel
  - Breadcrumbs for path navigation
- **Port Forwarding UI**: modal or side panel with visual rule list
- **Snippets panel**: side drawer for saved commands; can be inserted with click

### Key Differentiating UI Features
1. **Snippets system**: save, organize, and one-click paste commands — UI resembles a code snippet manager
2. **SFTP split-pane drawer**: very polished dual-pane file manager feel
3. **Team/Share UI**: host sharing and team workspace management (Pro feature) with clear visual affordances
4. **Cross-device sync UI**: visual indicators for synced vs local-only hosts
5. **Connection health**: subtle colored dots and latency sparklines
6. **Touch-friendly**: UI scaled and spaced so it works on iPad/Android tablets

---

## 2. WINDTERM

### Overall Window Layout
- **IDE-style layout**: left sidebar + main tabbed area + bottom panel strip + right optional panels
- Resembles Visual Studio or JetBrains IDEs more than a traditional terminal
- Heavier chrome than Termius; information-dense
- Window frame is custom or heavy native styling (especially on Windows)

### Sidebar Content and Structure
- **Left sidebar (~240px)**: multi-tab sidebar (similar to VS Code activity bar + explorer)
  - **Tabs on the left edge of the sidebar**: Sessions, Folders, Commands, Symbols, Outline, etc.
  - **Sessions tab**: tree of saved sessions grouped by protocol (SSH, Telnet, Serial, Shell, Cmd, PowerShell)
    - Each session shows name, protocol icon, last-used timestamp
    - Quick-connect bar at top of this tab
  - **Folders tab**: bookmarked remote directories for quick SFTP navigation
  - **Commands tab**: saved/quick command library (like snippets)
  - **Symbols/Outline**: for code navigation if editing files in the built-in editor
- Sidebar can be pinned or auto-hidden (slides in from left)

### Tab System
- **Top tabs** (traditional MDI tab bar)
  - Shows session name, protocol icon, connection state, modification dot for edited files
  - Close button always visible (×)
  - Tabs can be torn off into separate windows
  - **Tab groups / split view**: right-click a tab to split horizontal/vertical; creates a grid layout within the window
- Tab bar includes a "+" quick-launch button and a dropdown for recent sessions

### Terminal Panel Chrome
- **Panel headers visible**: each split panel has a small header strip with session name and close button
- 1px solid border between split panels (color matches theme border color)
- When a panel is focused, border/accent color changes to highlight active pane
- Optional line numbers or status per panel in the header strip

### Status Bar Content and Placement
- **Bottom status bar** (~28px, multi-section)
  - Left: current user@host, protocol, port
  - Center: keyboard state indicators (Caps Lock, Num Lock, Insert mode, IME status)
  - Right: terminal dimensions, cursor position (row:col), encoding (UTF-8), line ending mode (LF/CRLF)
  - Progress indicators for file transfers appear inline in status bar
- Status bar is information-dense and designed for power users

### Toolbar / Button Bar Placement and Contents
- **Top toolbar** (two rows possible)
  - **Main toolbar**: new session, connect/disconnect, reconnect, quick command dropdown, upload/download buttons, find in buffer, split view buttons, full screen, always-on-top toggle
  - **Address/connection bar**: protocol dropdown + hostname + port + username + connect button (resembles a browser address bar)
- **Side toolbars**: vertical button bars can be enabled on left/right edges for quick actions

### Color Scheme and Visual Style
- **Default**: dark theme with a slate/blue-gray base (#2b2b2b or similar)
- Alternate themes available: light, high-contrast, and custom color schemes
- Accent color is generally a bright blue or orange for selection/highlight
- Typography: system fonts for UI; terminal uses configurable mono font
- **Aesthetic**: utilitarian, power-user IDE. Not "pretty" in the modern SaaS sense, but highly functional. Dense information display. Slightly dated iconography
- Custom window decorations on Windows that feel "heavy"

### Bottom or Side Panels (SFTP, File Manager, Logs, etc.)
- **Bottom Panel**: tabbed strip with multiple panels
  - **SFTP / File Manager**: dual-pane (local/remote) with tree view + details view, similar to FileZilla or WinSCP built directly in
  - **Transfer Queue**: list of pending/active/completed file transfers
  - **Search Results**: find-in-files across remote or local
  - **Terminal Log**: scrollback buffer in a text view
  - **Compose Bar**: bottom input bar to type commands in a separate field
- **Right Panel**: can host session properties, quick commands, or macro recorder UI

### Key Differentiating UI Features
1. **Built-in graphical SFTP file manager**: extremely deep integration; file manager feels like a real FTP client inside the terminal
2. **IDE-style split/tab system**: horizontal/vertical splits with visible headers, very flexible grid layouts
3. **Command palette / quick commands**: sidebar panel dedicated to saved commands with parameter substitution UI
4. **Compose bar**: dedicated command input field at bottom (not inline in terminal)
5. **Rich session options UI**: every protocol gets a full properties dialog with dozens of options
6. **Code editor integration**: syntax highlighting if you open remote files for quick editing
7. **Macro recorder / playback UI**: record and replay terminal interactions with a visible interface

---

## 3. MOBAXTERM

### Overall Window Layout
- **Classic Windows MDI layout**: left sidebar + main tabbed workspace + optional bottom/right panels
- Very Windows-centric; window chrome follows classic Win32 or early Fluent style
- Title bar has the MobaXterm orange logo; optional menu bar visible
- Layout feels denser and older than Termius; "sysadmin toolbox" aesthetic

### Sidebar Content and Structure
- **Left sidebar (~200px)**: session manager tree
  - **Header**: Session button (opens new session dialog), quick connect bar
  - **Body**: Hierarchical tree organized by session type folders
    - User sessions, SSH sessions, RDP sessions, VNC sessions, SFTP sessions
    - Local shell sessions (Bash, Cmd, PowerShell, WSL)
    - Custom plugins add more folders
  - Each session entry shows: custom name, protocol icon, and a small colored indicator
  - Can create subfolders to organize
- Sidebar is toggleable but usually kept visible; primary navigation method

### Tab System
- **Top tabs** (classic tab control style)
  - Shows session name; on hover shows close button
  - Right-click context menu with split options, duplicate, rename
  - Tabs can be detached into separate floating windows
  - "+" button at end of tab bar for new session
- Tab strip is relatively tall compared to modern apps (~36px)

### Terminal Panel Chrome
- **Terminal surface**: basic rectangle, usually with a thin border
- When using split terminal: two terminals side by side with a draggable divider
- No per-panel headers; the tab handles identification
- Right-click inside terminal brings up a dense context menu

### Status Bar Content and Placement
- **Bottom status bar** (~26px)
  - Left: connection state text, current directory (if local shell)
  - Center: network status, X11 server status, CPU meter (optional plugin)
  - Right: caps/num lock, terminal dimensions, time
- Can be customized via settings; plugins can add status bar widgets

### Toolbar / Button Bar Placement and Contents
- **Top toolbar** (ribbon-like or classic toolbar)
  - Session (new session wizard)
  - Start local terminal (Bash / Cmd / PowerShell / WSL)
  - Quick connect dropdowns, SCP/SFTP send file button
  - Screenshot button, macros/recording buttons
  - Settings, plugins, help
- Buttons often have text labels + icons (older Windows style)

### Color Scheme and Visual Style
- **Default**: dark gray theme with distinctive **orange** MobaXterm brand accents
- Alternative: classic Windows light theme
- Terminal backgrounds: typically black or dark blue; highly configurable
- Typography: standard Windows UI fonts (Segoe UI for chrome, Consolas/Courier New for terminal)
- **Aesthetic**: Windows desktop utility from the 2010s. Functional, not fashionable. Icons are a mix of older bitmap styles and some newer PNGs. The overall impression is "powerful but dated."
- Heavy use of dialogs and property sheets for configuration

### Bottom or Side Panels (SFTP, File Manager, Logs, etc.)
- **Right Panel**: SFTP file browser (optional, toggle per session)
  - Shows remote directory tree + file list
  - Basic drag-and-drop support; upload/download buttons
- **Bottom Panel**: can display macro output, network scanner results, or plugin panels
- **Session-specific panels**: some session types (e.g., serial) open config panels docked to the side
- **X11 windows**: appear as separate floating windows managed by the integrated X server

### Key Differentiating UI Features
1. **All-in-one toolbox UI**: the sidebar isn't just SSH hosts — it shows RDP, VNC, FTP, SFTP, Serial, and plugin sessions all in one tree
2. **Plugin ecosystem UI**: a dedicated Plugins manager dialog; installed plugins add buttons, sessions types, and sidebar entries
3. **Macro / script recording**: visible record button in toolbar; recorded scripts editable in a panel
4. **Portable mode UI**: can run from a USB stick; UI adapts to portable config storage
5. **X11 server integration**: no other terminal here has a built-in X server with window management UI
6. **Session configuration wizards**: multi-step dialogs for creating new sessions with lots of protocol-specific options
7. **Multi-execution**: toolbar button to broadcast typed input to all visible terminal tabs simultaneously ("MultiExec")

---

## SYNTHESIS: COMMON UI PATTERNS ACROSS ALL THREE

### 1. Left Sidebar as Host/Session Manager
- **Universal pattern**: all three apps use a persistent left sidebar to manage saved connections/sessions
- Termius makes it most polished (tree + tags + search); WindTerm makes it most IDE-like (multi-tab sidebar); MobaXterm makes it most utilitarian (folder tree by protocol)
- **Takeaway for new design**: the left sidebar is the anchor. It should support search, folders/groups, and status indicators. Collapsibility is essential.

### 2. Top Tabs for Active Sessions
- **Universal pattern**: active sessions are represented as tabs across the top
- All support closing, reordering, and some form of split view
- **Takeaway**: top tabs remain the dominant metaphor. Consider supporting split layouts. Tab identity (name + status icon + protocol) is crucial.

### 3. Bottom Status Bar
- **Universal pattern**: a thin bottom strip showing connection health, terminal dimensions, and keyboard state
- Termius keeps it minimal; WindTerm makes it information-dense; MobaXterm allows plugin extensions
- **Takeaway**: status bar should be unobtrusive but informative. Connection status + terminal size + active session info is the baseline.

### 4. Integrated File Transfer Panel
- **Universal pattern**: all three embed SFTP/file transfer directly in the app window
- Termius uses a right drawer with split local/remote panes; WindTerm uses a bottom tabbed panel with a full file manager; MobaXterm uses a right-side browser
- **Takeaway**: embedding a dual-pane file transfer view is table stakes for a modern terminal app

### 5. Toolbar / Command Surface at Top
- **Universal pattern**: a top toolbar or command bar provides quick access to new sessions, file transfer, and settings
- Termius uses a thin icon bar; WindTerm uses a dense IDE toolbar + address bar; MobaXterm uses a ribbon-style button bar
- **Takeaway**: a top bar with search/address + key actions is expected. Keep it minimal or make it hideable.

### 6. Dark-First Aesthetic
- **Universal pattern**: all three default to dark themes; terminal apps are overwhelmingly dark-mode experiences
- Termius: modern dark SaaS look; WindTerm: IDE dark slate; MobaXterm: classic dark gray + orange
- **Takeaway**: design dark-first. Light theme can be an option, but the default should be a refined dark palette.

### 7. Snippets / Quick Commands
- **Emerging common pattern**: Termius and WindTerm both offer saved command libraries (snippets/quick commands)
- MobaXterm handles this via macros instead
- **Takeaway**: a command snippet/palette feature is becoming standard; UI should make insertion fast (click or hotkey)

### 8. Session Properties as Rich Dialogs/Wizards
- **Universal pattern**: creating or editing a connection opens a detailed configuration dialog
- All three expose protocol-specific settings (SSH keys, ports, keepalive, terminal type, etc.) through multi-tab or wizard UIs
- **Takeaway**: a well-organized session properties dialog is necessary; organize by category (Connection / Authentication / Terminal / Advanced)

---

## DESIGN IMPLICATIONS FOR PLUTO'S TERMINALS

| Element | Recommendation |
|---------|---------------|
| **Layout** | Left sidebar + top tabs + main terminal + optional right/bottom panels |
| **Sidebar** | Searchable tree with groups/tags, status dots, collapsible. Support both icon-rail and expanded modes |
| **Tabs** | Top-mounted, minimal height, show name + protocol icon + connection state. Support drag-to-reorder and tear-off |
| **Terminal Chrome** | Edge-to-edge; minimal borders. Active panel indicated by subtle accent border |
| **Status Bar** | Bottom, thin, muted. Connection status + terminal size + active profile |
| **Toolbar** | Thin top bar with quick-connect search + icon buttons. Auto-hide option |
| **File Transfer** | Right-side drawer or bottom panel, dual-pane local/remote, drag-and-drop |
| **Theme** | Dark default with one accent color. CSS-variable-driven theming for whole-app consistency |
| **Snippets** | Side drawer or palette (⌘K style) for quick command insertion |
| **Split Layout** | Support horizontal/vertical splits with draggable dividers and visible (but subtle) panel headers |
