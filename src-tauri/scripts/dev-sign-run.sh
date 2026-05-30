#!/bin/sh
# (C)
# Cargo `runner` for `tauri dev` / `cargo run` on macOS.
#
# Why: on Apple Silicon, cargo ad-hoc-signs the debug binary with a fresh cdhash
# every build. The macOS Keychain ties an "Always Allow" grant (for the SSH
# credential vault, service com.plutothedev.terminals.ssh) to the app's code
# signature, so each rebuild invalidates the grant and re-prompts. Re-signing
# with a STABLE self-signed identity keeps the designated requirement constant
# (identifier + cert leaf), so the grant survives rebuilds.
#
# This is a NO-OP for anyone who doesn't have the "Pluto Terminals Dev" identity
# (other developers, CI): it just runs the binary as-is. Create the identity via
# docs/dev-codesign.md to opt in. Only wired up for aarch64-apple-darwin (see
# .cargo/config.toml), so non-macOS targets never see it.

set -e
BIN="$1"
shift

IDENTITY="Pluto Terminals Dev"
if command -v security >/dev/null 2>&1 && \
   security find-identity -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  # --force replaces cargo's ad-hoc signature; failure is non-fatal (fall back
  # to running whatever cargo produced rather than blocking the dev launch).
  codesign --force --sign "$IDENTITY" --identifier com.plutothedev.terminals "$BIN" 2>/dev/null \
    && echo "[dev-sign] re-signed with '$IDENTITY'" >&2 \
    || echo "[dev-sign] sign failed; running unsigned" >&2
fi

exec "$BIN" "$@"
