# Label clarity pass — design (2026-08-12)

Pluto's ask: every button label should say what the button does, seamlessly readable. Scope chosen: **everything** (chrome + modals + menus + context menus). Inventory: 218 interactive labels across 22 surfaces (subagent sweep); most were already fine. Approved rename table (pluto approved "apply all"):

| Surface | Before | After | Why |
|---|---|---|---|
| Toolbar | MultiX | Broadcast | MobaXterm jargon |
| Toolbar | Agent / Agents (adjacent) | Agent Mode / Fleet | one letter apart, different features; Fleet matches v0.6.0 "fleet views" |
| Bottom bar | F2 Tab | F2 New Tab | says the action |
| Bottom bar | F9 Macro | F9 Macros | opens the manager |
| Tools menu | Turn on/off broadcast (MultiExec) | Turn on/off broadcast typing | kill MultiExec brand user-facing |
| Tools menu | Broadcast targets… (choose terminals) | Broadcast targets… | detail → tooltip |
| Modal title | MultiExec — choose broadcast targets | Broadcast typing — choose targets | same sweep |
| Status bar | "Broadcast (MultiExec) is on…" | "Broadcast typing is on…" | same sweep |
| Welcome banner | "MultiExec broadcasts your typing…" | "Broadcast sends your typing…" | same sweep |
| View menu | Hide tools panel / Show snippets panel | Hide/Show tools panel | one panel, one name |
| View menu | Skins & appearance… | Themes & appearance… | standard term |
| Settings menu | Master password… | App lock (master password)… | says what it's for |
| Tools menu | My shares (shared gists)… | My shared gists… | tighter |
| Terminal menu + palette | Equalize splits | Equalize split sizes | object named |
| Fleet panel header | Agents | Fleet | matches toolbar |

Riding along (same platform-label class as commit de0f98b): menu-bar shortcut chips now render through `formatCombo` (MobaMenuBar), and the hardcoded `"Cmd+R"` shortcut string became canonical `"Ctrl+R"`.

Deliberately unchanged: lowercase button voice (save/cancel/run ↵ = brand style), OLED, "New agent (git worktree)" (dev audience), SFTP/Assistant/Monitor dock tabs, Palette, symbol prefixes (▶ Replay).

Open follow-up for pluto: the snippets panel carries three names — toolbar "Workflows", Tools menu "Snippets panel", View menu "tools panel". Unifying needs a product-name decision (Workflows vs Snippets), not taken in this pass.
