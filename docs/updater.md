# Auto-update (signed)

Why this exists: without it, a security fix propagates **only** as a manual
re-download through a SmartScreen/Gatekeeper warning, and never reaches a copy
that is already installed. This app vendors OpenSSL, libssh2 and libgit2 and
links an unmaintained `vnc` crate that parses untrusted data from remote
servers, so a forced patch release is a *when*, not an *if*. The updater is what
makes that patch reachable.

## Trust model

Update payloads are **minisign-verified against the public key baked into the
build** before anything is written or executed. The release host is therefore
*not* a trust anchor: someone who fully controls the GitHub release assets still
cannot ship code without the private key.

## Where the config lives (and why it is split)

The config is split across two files, and the split is load-bearing — both
halves were found the hard way, by building and then actually launching:

- **`src-tauri/tauri.conf.json`** (base) carries `plugins.updater` with an
  **empty** `pubkey` and the real endpoint. The key must be PRESENT: the plugin
  panics during startup if `plugins.updater` is missing entirely —
  `PluginInitialization("updater", "... invalid type: null, expected struct
  Config")` — so a build without it produces an app that **does not start at
  all**. An empty pubkey deserializes fine and simply means "cannot verify
  anything", which the app degrades from gracefully.
- **`src-tauri/tauri.release.conf.json`** (release-only overlay, merged by CI
  via `--config src-tauri/tauri.release.conf.json`) supplies the real `pubkey`
  and `createUpdaterArtifacts`. These are kept out of the base because the
  bundler hard-fails any build where a **non-empty** pubkey is configured
  without `TAURI_SIGNING_PRIVATE_KEY`:

  ```
  Error A public key has been found, but no private key.
  ```

  In the base config that would break every local `npm run tauri build` for
  anyone without the signing key.

Net effect: local builds run and launch normally with the updater inert, and
**only CI signs**. A locally-built app's `check()` fails on the empty pubkey and
the banner falls back to the plain download link — the intended dev behavior.

That inverts the usual risk: **the private key is now the crown jewel.** Anyone
holding it can push code to every installed copy. Treat it like a signing
certificate, not like a config value.

## One-time setup

> **Until all three steps below are done, tagging a release will FAIL in CI** at
> the bundle step with `A public key has been found, but no private key`. That is
> deliberate: a release that silently shipped without updater artifacts would
> leave every user stranded on that version with no way to be patched, and the
> failure would only surface months later when a fix needed to go out. Better to
> fail the release now, loudly. Local `npm run tauri build` is unaffected.

### 1. Generate the keypair

```bash
npm run tauri signer generate -- -w "$HOME/.tauri/plutos-terminal.key"
```

This writes the **private** key to that path and prints the **public** key.
Keep the private key off the repo (that path is outside it, which is the point).

> Choosing a password: if you set one, you must also set the
> `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret below. An empty password is common
> for CI and is acceptable here **because the key file itself never leaves your
> machine and GitHub secrets** — but it means anyone who obtains the file can
> sign releases immediately. Your call; the workflow supports both.

### 2. Put the public key in the config

Replace the `plugins.updater.pubkey` placeholder in
**`src-tauri/tauri.release.conf.json`** with the printed public key, one long
base64 line.

Leave the empty `pubkey: ""` in `src-tauri/tauri.conf.json` alone — see the
split above; putting a real key there breaks local builds, and removing the
block entirely stops the app from starting.

### 3. Add the CI secrets

In the **source** repo → Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `~/.tauri/plutos-terminal.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you chose, or omit if none |

`release.yml` passes both to the build step. Without them the build still
produces installers, but no `.sig` files, so no `latest.json` is published and
the workflow logs a loud warning that auto-update stayed dark.

## How a release flows

1. Tag push → `release.yml` builds macOS + Windows with
   `createUpdaterArtifacts: true`, producing the normal installers **plus** a
   signed updater payload (`.app.tar.gz` / `.msi.zip`) and a `.sig` for each.
2. The publish job sanitizes asset names, writes `SHA256SUMS`, then assembles
   `latest.json` mapping each platform to its payload URL + signature.
3. `latest.json` is uploaded with the release. The app's configured endpoint is
   `https://github.com/plutothedev/plutos-terminals/releases/latest/download/latest.json`.
4. On launch the app calls `check()`; if a newer signed version exists the
   banner offers **Install & restart**.

## Backwards compatibility

Versions already in the wild have no updater, so **they will not auto-update to
this one** — the first updater-enabled release still has to be installed by
hand. Everything from that release forward can update itself. That is the
one-time cost of not having shipped this earlier.

## Verifying it works

You cannot fully test this from a dev build; it needs two real releases.
Cheapest honest check:

1. Publish release **A** with the updater wired and the secrets set. Confirm
   `latest.json` is attached and its `platforms` keys are `darwin-universal`
   and `windows-x86_64`.
2. Install A by hand.
3. Bump the version, publish release **B**.
4. Launch A. The banner should offer **Install & restart**, and accepting it
   should relaunch into B.

If B does not appear: check that `latest.json` on the *latest* release points at
B's assets, and that A's embedded pubkey matches the key that signed B.

## Failure behavior (by design)

- Bad/placeholder pubkey, unreachable endpoint, missing `latest.json`, or a
  signature that does not verify → `check()` throws, the app catches it, and the
  banner degrades to the plain GitHub download link. It never silently installs
  something unverified.
- A failed install surfaces the error in the banner and leaves the download
  button as the way out.

## If the private key is ever exposed

Rotate immediately: generate a new keypair, ship a release signed with the old
key that contains the new pubkey, then switch CI to the new key. Users who skip
that bridging release will have to reinstall by hand. Losing the key entirely
has the same consequence, so back it up somewhere you trust.
