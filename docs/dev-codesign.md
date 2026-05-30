<!-- (C) -->
# Stable dev code-signing (macOS) — keep the Keychain "Always Allow" from re-prompting

## The problem

The SSH credential vault (`src-tauri/src/vault.rs`) stores SSH passwords in the
macOS Keychain (service `com.plutothedev.terminals.ssh`). macOS ties an
"Always Allow" grant to the app's **code signature**. On Apple Silicon, `cargo`
ad-hoc-signs the debug binary with a **fresh cdhash every build**, so each
`tauri dev` rebuild invalidates the grant and macOS re-prompts on the next SSH
connect. (A signed/notarized production build has a stable signature, so this is
a dev-only annoyance.)

## The fix

Re-sign the debug binary with a **stable self-signed identity** on every run, via
a Cargo `runner` (`src-tauri/.cargo/config.toml` → `scripts/dev-sign-run.sh`).
The constant signature keeps the designated requirement stable
(`identifier "com.plutothedev.terminals" and certificate leaf = H"…"`), so the
Keychain grant survives rebuilds. The runner is a **no-op** for anyone without
the identity, so it's safe for other developers / CI.

## One-time setup

```sh
# 1) Create a self-signed code-signing cert (LibreSSL/OpenSSL 3 both fine).
WORK=$(mktemp -d); cd "$WORK"
cat > openssl.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Pluto Terminals Dev
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -nodes -days 3650 -config openssl.cnf
# -legacy + a real password: macOS can't import OpenSSL 3's default PKCS12 MAC.
openssl pkcs12 -export -legacy -macalg sha1 -inkey key.pem -in cert.pem -out cert.p12 -passout pass:CHANGEME -name "Pluto Terminals Dev"

# 2) Import into the login keychain (allow codesign to use the key).
security import cert.p12 -k ~/Library/Keychains/login.keychain-db -P CHANGEME -T /usr/bin/codesign

# 3) Authorize codesign to use the key WITHOUT prompting (needs your login
#    password at the prompt). Omit the keychain path so it uses the default.
security set-key-partition-list -S apple-tool:,apple: -s -l "Pluto Terminals Dev"

# 4) Scrub the private-key files — the key now lives in the keychain.
shred -u key.pem cert.p12 2>/dev/null || rm -f key.pem cert.p12
cd - && rm -rf "$WORK"
```

Verify:

```sh
cp src-tauri/target/debug/plutos-terminals /tmp/x
codesign --force --sign "Pluto Terminals Dev" --identifier com.plutothedev.terminals /tmp/x   # exit 0, no prompt
codesign -d --requirements - /tmp/x   # => identifier "…" and certificate leaf = H"…"  (stable; NOT cdhash)
rm -f /tmp/x
```

Then the **first** SSH connect after this re-prompts once for the vault item
(`…terminals.ssh`) — click **Always Allow**. Because the signature is now stable,
it sticks across all future rebuilds.

## Notes / trade-offs

- The cert is **self-signed and untrusted** — it grants no system trust; it only
  provides a constant identity for the Keychain ACL. Signatures made with it are
  meaningless to anyone else.
- `runner` only affects `cargo run`/`test`/`bench` — never `cargo build`/`check`.
- Scoped to `aarch64-apple-darwin`; Intel/Linux/Windows are unaffected.

## Remove it

```sh
security delete-identity -c "Pluto Terminals Dev"      # remove cert + key
rm src-tauri/.cargo/config.toml src-tauri/scripts/dev-sign-run.sh
```
