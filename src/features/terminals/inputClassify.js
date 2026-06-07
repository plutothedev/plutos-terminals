// (C)
// Heuristic: is a line of text a shell COMMAND (run as-is) or NATURAL LANGUAGE
// (send to the AI to turn into a command)? Used by the Ask AI bar to auto-route
// on Enter. Conservative on the NL side — when it looks like English we ask the
// model rather than running gibberish in the shell.

// Common binaries / builtins whose presence as the first token strongly implies
// a command. (Cross-platform: POSIX + a few Windows/PowerShell.)
const KNOWN_CMDS = new Set([
  "ls", "cd", "pwd", "cat", "echo", "cp", "mv", "rm", "mkdir", "rmdir", "touch",
  "grep", "rg", "head", "tail", "less", "more", "chmod", "chown", "ln", "du", "df",
  "ps", "kill", "pkill", "clear", "export", "env", "printenv", "which", "whereis",
  "man", "sudo", "su", "ssh", "scp", "sftp", "rsync", "curl", "wget", "tar", "zip",
  "unzip", "gzip", "gunzip", "mount", "umount", "ln", "stat", "file", "tree",
  "git", "gh", "npm", "npx", "pnpm", "yarn", "node", "deno", "bun", "python",
  "python3", "pip", "pip3", "poetry", "ruby", "gem", "bundle", "cargo", "rustc",
  "rustup", "go", "java", "javac", "mvn", "gradle", "make", "cmake", "ninja",
  "gcc", "g++", "clang", "docker", "podman", "kubectl", "helm", "terraform",
  "ansible", "vagrant", "aws", "gcloud", "az", "systemctl", "service",
  "journalctl", "apt", "apt-get", "dpkg", "brew", "dnf", "yum", "pacman", "snap",
  "flatpak", "code", "vim", "vi", "nano", "emacs", "nvim", "tmux", "screen",
  "awk", "sed", "cut", "sort", "uniq", "wc", "xargs", "tee", "jq", "yq",
  "ping", "traceroute", "nslookup", "dig", "netstat", "ss", "ip", "ifconfig",
  "nc", "telnet", "lsof", "uname", "whoami", "hostname", "uptime", "free",
  // Windows / PowerShell
  "dir", "cls", "copy", "del", "move", "ren", "type", "where", "winget", "choco",
  "scoop", "pwsh", "powershell", "cmd", "ipconfig", "tasklist", "taskkill",
]);

// First tokens that are ALSO everyday English verbs — treat as a weak command
// signal so "find files over 100MB" routes to AI but "find . -name x" runs.
const AMBIGUOUS = new Set([
  "find", "make", "test", "sort", "type", "where", "clear", "set", "time",
  "kill", "top", "cut", "yes", "at", "date", "who", "id", "tree", "free", "more",
]);

function firstToken(s) {
  const t = s.trim().split(/\s+/)[0] || "";
  return t.toLowerCase().replace(/\.exe$/, "");
}

// Returns { kind: "command" | "nl" | "empty", confidence: "high" | "low" }.
export function classifyInput(text) {
  const s = String(text || "").trim();
  if (!s) return { kind: "empty", confidence: "low" };

  const words = s.split(/\s+/);
  const first = firstToken(s);

  // Hard command signals — shell syntax that never appears in plain English.
  const shellOps = /[|;]|&&|\|\||\$\(|`|>>|\d?>|<\(/.test(s);
  const hasFlag = /(^|\s)-{1,2}[a-zA-Z]/.test(s);
  const pathStart = /^(\.\/|\.\.\/|\/|~\/|[a-zA-Z]:\\)/.test(s);
  const assignStart = /^\w+=\S/.test(s);
  const psVerb = /^(get|set|new|remove|invoke|test|start|stop|select|where|out|add|clear|copy|move|rename|import|export|write|read)-[a-z]/i.test(s);

  if (shellOps || hasFlag || pathStart || assignStart || psVerb) {
    return { kind: "command", confidence: "high" };
  }

  const known = KNOWN_CMDS.has(first);
  const ambiguous = AMBIGUOUS.has(first);

  if (known && !ambiguous) return { kind: "command", confidence: "high" };

  if (ambiguous) {
    // Bare or two-token (e.g. "make", "git log") → command; wordy → English.
    return words.length <= 2 ? { kind: "command", confidence: "low" } : { kind: "nl", confidence: "low" };
  }

  // Single token, no spaces, command-shaped (e.g. "htop", "./run", "build.sh").
  if (words.length === 1 && /^[\w.\-/]+$/.test(s)) {
    return { kind: "command", confidence: "low" };
  }

  // Multi-word, unknown first token, no shell syntax → natural language.
  return { kind: "nl", confidence: words.length >= 3 ? "high" : "low" };
}
