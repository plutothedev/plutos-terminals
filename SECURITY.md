# Security Policy

## Supported versions

Only the **latest release** on the
[releases page](https://github.com/plutothedev/plutos-terminals/releases/latest)
receives security fixes. If you found an issue on an older version, please
reproduce it on the latest release before reporting.

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues:

- **GitHub:** use [private vulnerability reporting](https://github.com/plutothedev/plutos-terminals/security/advisories/new)
  ("Report a vulnerability" under the repo's Security tab), or
- **Discord:** DM `plutothedev` on the [Pluto Discord](https://discord.gg/3cZQVgKF).

Include steps to reproduce and the app version (bottom-left of the status bar).
You'll get an acknowledgment as soon as the report is read, and credit in the
release notes if you want it.

## Security posture

Pluto's Terminal is local-first: there is no account, no sign-up, and no
telemetry. Provider API keys and saved SSH passwords are stored in the OS
keychain (Windows Credential Manager / macOS Keychain), not in plaintext
storage, and are only ever sent to the provider or host you configured. SSH
host keys are verified against `~/.ssh/known_hosts`, RDP certificates are
pinned trust-on-first-use, and anything you share as a gist is secret-scanned
and masked before upload, with a byte-exact preview. Release builds are not yet
code-signed; every release publishes a `SHA256SUMS` file so you can verify your
download before running it (see the README's Install section).

## Audits

Two full-codebase audits are in the repo, including what they found and what
was fixed:

- [Security audit, 2026-06-08](docs/security-audit-2026-06-08.md) — 68-agent
  static security review; both criticals and 19 of 22 highs closed in v0.3.6.
- [Full audit, 2026-06-09](docs/full-audit-2026-06-09.md) — correctness,
  concurrency, and UX audit; P1/P2 findings fixed.
