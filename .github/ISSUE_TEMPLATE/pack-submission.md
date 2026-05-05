---
name: 📦 Pack submission
about: Submit a .deck.json prompt pack for the bundled set
title: "[pack] "
labels: pack
---

## Pack name

<!-- Human-readable. E.g. "Solana Devnet Bot Workflow" -->

## What it does

<!-- 1-3 sentences. What workflow does this pack support? What agent setup? -->

## Pack contents

<!-- Paste the full .deck.json or attach as a file. -->

```json
{
  "schema": "plutos-terminals/deck.json/v0",
  ...
}
```

## Cross-machine portability check

- [ ] Uses templated paths (`${USERPROFILE}` / `${HOME}` / `${VAULT}`) where applicable, not hardcoded user-specific paths
- [ ] `notes[]` documents any prerequisites (env vars, installed tools, accounts)
- [ ] Does NOT reference private resources (pack should work for any user)
- [ ] Tested locally — `📁 from file` load + spawn shells without errors

## Where you'd like it bundled

- [ ] **Bundled with next release** — ships in the app for everyone (curation review applies)
- [ ] **Community-only** — share in Pluto Discord `#packs`, not bundled
