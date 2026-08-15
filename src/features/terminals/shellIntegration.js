// (C)
// Pure builders for shell-integration setup strings (prompt themes, OSC-133
// command-block marks, OSC-1337 command/cwd capture) for both POSIX shells
// (zsh/bash) and Windows PowerShell.
//
// Extracted verbatim from TerminalPane.jsx's spawn effect (behavior-preserving
// refactor). Every function here is side-effect-free and captures no closure /
// ref / state — the returned strings are byte-identical to the previous inline
// code. The OSC *handlers* (term.parser.registerOscHandler) that consume these
// marks at runtime are NOT pure (they touch term + refs) and stay in the
// component.

// POSIX (zsh/bash) shell-integration setup. Returns the three strings the
// component writes to the PTY on a fresh local tab.
//
// `cmdNonce` (audit H1) is a per-session secret baked into the PlutoCmd emit so
// the OSC-1337 handler can tell a report from OUR OWN injected preexec hook from
// one printed by arbitrary stream content — a cat'd file, an MOTD, a compromised
// process. Only reports carrying the matching nonce are promoted into the
// trusted, persistent, one-click-re-runnable command history. The nonce is
// injected only into LOCAL shells (SSH/serial connect to remote shells we never
// inject into), so every un-nonced remote report is correctly rejected.
export function buildPosixShellInit(cmdNonce = "") {
  // Colorful output like MobaXterm: BSD/GNU ls colors + colored grep/less
  // + a few quality-of-life aliases. (Kept short so the welcome init fits
  // comfortably in one shell line alongside the big welcome box.)
  const colors = "export CLICOLOR=1; export LSCOLORS=ExGxFxdaCxDaDahbadacec; export LESS='-R'; alias grep='grep --color=auto'; alias ll='ls -lah'; alias la='ls -laGh';";
  // MobaXterm v12.4 segmented prompt: green  date  cyan  time
  // yellow  path, joined by powerline  arrows. Icons are Nerd-Font
  // glyphs from the bundled MesloLGS NF (calendar , clock ,
  // folder ) — NOT color emoji: emoji fall back to Apple Color
  // Emoji, which renders taller/wider than the text cell and gets clipped
  // by the segment edges. Nerd glyphs are single-cell and monochrome
  // (they take the segment's fg colour), so they sit cleanly like the
  // powerline arrows. Each  carries fg = the colour it comes from,
  // bg = the colour it goes to, so the segments blend like MobaXterm's.
  const zshPrompt = "PROMPT='%K{2}%F{0}  %D{%d/%m/%Y} %K{6}%F{2}%F{0}  %* %K{3}%F{6}%F{0}  %~ %k%F{3}%f '";
  const bashPrompt = "PS1='\\[\\e[42;30m\\]  \\D{%d/%m/%Y} \\[\\e[32;46m\\]\\[\\e[30;46m\\]  \\t \\[\\e[36;43m\\]\\[\\e[30;43m\\]  \\w \\[\\e[0;33m\\]\\[\\e[0m\\] '";
  // OSC 133 shell integration (command blocks): emit a prompt mark (A)
  // and a command-done mark (D;<exit>) so the UI can pair them into
  // blocks and flag failures. zsh via add-zsh-hook precmd; bash by
  // prepending to PROMPT_COMMAND (both preserve the user's own hooks).
  // $? is read FIRST so the real exit code survives.
  const osc133 =
    `__plt133z(){ local __e=$?; printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]1337;PlutoCwd=%s\\007' "$__e" "$(printf '%s' "$PWD" | base64 2>/dev/null | tr -d '\\n')"; }; ` +
    `__plt133b(){ local __e=$?; printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]1337;PlutoCwd=%s\\007' "$__e" "$(printf '%s' "$PWD" | base64 2>/dev/null | tr -d '\\n')"; }; ` +
    `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook precmd __plt133z 2>/dev/null; ` +
    `elif [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND="__plt133b\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi`;
  const promptSetup = `${colors} if [ -n "$ZSH_VERSION" ]; then ${zshPrompt}; elif [ -n "$BASH_VERSION" ]; then ${bashPrompt}; fi; ${osc133}`;
  // Command-history capture: emit ESC]1337;PlutoCmd=<base64> for each
  // command the shell is about to run. zsh via preexec (clean); bash via
  // a guarded DEBUG trap (best-effort — dedup on the app side handles
  // pipeline repeats). Sent as its own line so promptSetup stays under
  // the tty canonical line-length limit (MAX_CANON).
  const cmdCapture =
    `__pltcmdz(){ printf '\\033]1337;PlutoCmd=${cmdNonce}:%s\\007' "$(printf '%s' "$1" | base64 | tr -d '\\n')"; }; ` +
    `__pltcmdb(){ case "$BASH_COMMAND" in __plt*|"$PROMPT_COMMAND") return;; esac; printf '\\033]1337;PlutoCmd=${cmdNonce}:%s\\007' "$(printf '%s' "$BASH_COMMAND" | base64 2>/dev/null | tr -d '\\n')"; }; ` +
    `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook preexec __pltcmdz 2>/dev/null; ` +
    `elif [ -n "$BASH_VERSION" ]; then trap '__pltcmdb' DEBUG; fi`;
  return { promptSetup, cmdCapture };
}

// Windows PowerShell shell-integration setup. Returns the four strings the
// component writes to the PTY on a fresh local tab on Windows. `cmdNonce` is
// baked into the PlutoCmd emit — see buildPosixShellInit (audit H1).
export function buildPowerShellInit(cmdNonce = "") {
  const psEnc = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`;
  // Themed powerline prompt (green date  cyan time  yellow cwd) that ALSO
  // emits OSC-133: D;<exit> closes the previous command block, A opens the
  // prompt — the UI pairs them into blocks (✓/✗ status). $? / $LASTEXITCODE
  // are captured FIRST so the real exit code survives.
  const psPrompt =
    `function prompt { ` +
    `$c = if ($?) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }; ` +
    `$e = [char]27; $b = [char]7; $a = [char]0xE0B0; ` +
    `$o = "$e]133;D;$c$b$e]133;A$b$e]1337;PlutoCwd=$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path)))$b"; ` +
    `$d = Get-Date -Format 'dd/MM/yyyy'; $t = Get-Date -Format 'HH:mm:ss'; ` +
    `$p = $PWD.Path; if ($HOME -and $p.StartsWith($HOME)) { $p = '~' + $p.Substring($HOME.Length) }; ` +
    `"$o$e[42;30m $d $e[32;46m$a$e[30;46m $t $e[36;43m$a$e[30;43m $p $e[0;33m$a$e[0m " }`;
  // Command-history capture: emit OSC 1337 PlutoCmd=<base64> as each command
  // is submitted (PSReadLine's history handler ≈ a preexec hook).
  const psHist =
    `if (Get-Module PSReadLine) { Set-PSReadLineOption -AddToHistoryHandler { param($l) ` +
    `try { $e=[char]27; $b=[char]7; $x=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($l)); ` +
    `[Console]::Write("$e]1337;PlutoCmd=${cmdNonce}:$x$b") } catch {}; $true } }`;
  // Autosuggestions + Tab completion (Milestone 2): PSReadLine renders
  // fish-style inline ghost text (accept with →/End/Ctrl+F) + a Tab
  // completion menu — natively, right in xterm. Needs PSReadLine >= 2.1
  // (PowerShell 7 / updated 5.1); guarded → silent no-op on stock 5.1.
  const psComplete =
    `$prl = Get-Module PSReadLine; if ($prl -and $prl.Version -ge [version]'2.1.0') { ` +
    `Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView; ` +
    `Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete }`;
  return { psEnc, psPrompt, psHist, psComplete };
}
