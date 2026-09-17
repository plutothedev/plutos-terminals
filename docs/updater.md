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

`release.yml` passes both to the build step. Without them the release does not
go out at all. With a real `pubkey` in the overlay the bundler refuses to build
(the callout above), and if a build ever does reach the publish job with no
`.sig` files, the `latest.json` step fails the release. It used to warn and
publish anyway, which is the worst outcome on offer: that release becomes
`/releases/latest`, and the endpoint below is under `/releases/latest/download/`,
so every installed copy 404s and goes dark with no signal to the user or to us.

Recovery is to restore the secret and re-run **all** jobs on the tag. Not
"Re-run failed jobs": a build leg that produced installers without `.sig` files
counts as succeeded, so re-running only the publish job re-downloads the same
unsigned artifacts and fails identically.

## How a release flows

The release procedure itself (version bump, tag, what CI asserts, what to do
when a leg fails) is canonical in `CLAUDE.md` under "Release process". Only the
updater-specific half is written down here:

1. Tag push → `release.yml` builds macOS + Windows with
   `createUpdaterArtifacts: true`, producing the normal installers **plus** a
   signed updater payload (`.app.tar.gz` on macOS; on Windows the `.msi` itself,
   Tauri v2 signs the installer directly and there is no `.msi.zip`) and a `.sig`
   for each.
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
   `latest.json` is attached and its `platforms` keys are `darwin-aarch64`,
   `darwin-x86_64` and `windows-x86_64`. NOT `darwin-universal`: the updater
   builds its lookup key from `cfg!(target_arch)`, so a universal binary asks
   for one of the two arch keys and a manifest carrying only `darwin-universal`
   fails with `TargetsNotFound`, which the UI cannot tell apart from "no update
   available". `release.yml` asserts all three keys for this reason.
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
