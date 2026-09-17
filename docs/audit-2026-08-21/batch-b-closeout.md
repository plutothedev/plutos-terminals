<!-- (C) -->
# Batch B closeout: theme correctness

Applied 2026-08-21 against `731afc5`. Nothing committed; changes are in the working
tree.

**Result: measured at runtime with transitions disabled, across all 14 skins.**

| skin | contrast failures before | after |
|---|---|---|
| `moba-light` (daily driver) | 27 | **4** |
| `daylight` (second light skin) | not measured | **5** |
| `moba` | 13 | **13, unchanged** |
| `oled` | 13 | **13, unchanged** |

Plus a resolver check over every site touched: **zero appearance changes across all
12 dark skins**, both light skins improved at every site.

## The batch failed twice before it worked, and the first failure was my brief

I scoped this as three skins. **There are fourteen**, and **two of them are light**:
`moba-light` and `daylight`. My runtime pass had measured three, so I wrote "keep
moba and oled unchanged" as if that were the whole constraint. Every regression
that followed traces back to that.

**Round 1** produced a CRITICAL: the tab-rename fix used `--phn-hover-bg` as the
fill, which is declared in only 4 of 14 blocks and is a *white alpha* at `:root`,
so under `daylight` the input inverted to **1.13:1**. The bug being fixed was
relocated to a different skin rather than removed. Round 1 also repainted the F-key
bar in 7 dark skins while killing its own hover fill, and bridged three tokens at
`:root` in a way that silently recoloured 10 skins including a cyan-to-periwinkle
hue change.

The lesson is structural, not per-site: **eleven separate colour bugs were one
token-system completeness problem.** A token used at a site must be declared in
every skin that can be active, or the site inherits a value from a skin family it
is not in.

## What actually landed

**Token completeness first, sites second.** `--phn-hover-bg` is now declared in all
14 blocks, with the 11 dark skins keeping their inherited value verbatim and the
light skins getting a black alpha. The `:root` declaration was **removed entirely**
rather than left as a backstop, because the backstop is the trap.

**`--phn-text-bright` declared per skin, not aliased.** Aliasing it to
`--phn-text-active` shifted moba and oled from `#F2F4F7` to `#eceef0`. Per-skin
declaration pins all 12 dark skins to exactly what they rendered, and gives the two
light skins a dark value. The Assistant textarea goes from 1.05:1 to 21.00:1.

**The F-key bar was fixed where the problem was.** Round 1 moved the bar to
`--phn-surface-bg`, which repainted 7 dark skins and did not even fix the contrast
(still 3.34:1). The real issue was that moba-light's own tier values were validated
against `#ececec` while the bar paints on `#d9d9d9`. Fixing the two light skins'
token values instead takes the labels 4.07 to 6.58 and the shortcut keys 2.80 to
4.74, with 12 dark skins byte-identical.

**A new `--phn-focus-outline` token.** Pointing the global focus ring at
`--phn-link` would have recoloured it in 10 dark skins. The new token is pinned to
the old hardcoded `#7c9cf5` in every dark skin; `moba-light` goes 1.88 to 3.53 and
`daylight` 2.65 to 5.57, both over the 3:1 non-text floor.

**`--phn-panel-fg`, applied by hand after the third failure.** The `--phn-text`
misspelling (undeclared, frozen at `#D3D7DD`, invisible in light) was repointed to
`--phn-text-fg`. Semantically tidy, but it recoloured **all 12 dark skins** and
dropped amber to 4.41:1. The chip beside it had already solved the same problem
correctly with a token pinned to the value the site rendered before, so that
pattern was generalised from `--phn-chip-fg` to `--phn-panel-fg` and applied to the
assistant reply body, the Monitor process rows and the chip label. Zero dark
change, both light skins fixed.

Worth stating plainly: adopting each skin's own body colour there may well be the
nicer design. But that is a **taste call for pluto to make deliberately**, not a
side effect of a bug fix, and it costs amber its AA compliance.

## The gate is the durable part

`headerSkins.tokens.test.js` went from 6 tests to 13 and now checks four
properties: every used token is declared; every skin-dependent colour is declared
in all 14 blocks plus `deriveChrome()`; no literal colour sits at `:root` outside a
five-entry allowlist that carries its reasons; and the light skins are measurably
light.

It was proven by 11 mutations. The entire pre-fix tree fails 9 of 13. Deleting
`--phn-hover-bg` from `daylight` alone fails 2. Re-adding it as a `:root` white
alpha fails 1. Aliasing `--phn-text-bright` fails 2. Repainting the fnbar fails 1.

**It also earned its place immediately by finding five undeclared tokens the audit
missed**, two worse than the original finding: assistant reply bodies at 1.44:1 and
Monitor process rows at 1.22:1 in light mode.

## Where an agent corrected me, and was right

I asked for the three `:root` token bridges to be deleted and the use sites renamed
instead. The agent deleted the bridges and refused the renames, with a correct
argument: `--phn-accent: var(--phn-link)` at `:root` and `var(--phn-link)` at the
site **resolve to identical pixels in every skin**, so the rename is not an
alternative to the bridge, it *is* the bridge. It produces the same
cyan-to-periwinkle recolour that was cited as the defect. Declaring `--phn-accent`
per skin does not work either, because its two use-site groups carry different
fallbacks (`#7c9cf5` in `terminals.css`, `#6cf` in `KeybindingsSection.jsx`), so no
single value leaves both rendering what they render today.

All three names are locked in the gate's `KNOWN_GAPS` list, asserted by exact
equality so the set can only shrink.

## Accepted debt

- **The three misspelled tokens** (`--phn-accent`, `--phn-border`, `--phn-fg-dim`,
  five sites, two files) still resolve via site fallbacks. The zero-dark-change
  route is to split the name so each use-site group gets its own token pinned to
  what it renders today. The alternative is to accept the recolour as a deliberate
  design call. That is a taste question, not a correctness one.
- **`moba-light`'s hint tier is sub-AA by design.** `--phn-text-faint` is 3.34:1 on
  `#ececec`. Raising it to 4.5 needs about `#6b6b6b`, which is `--phn-text-dim`, so
  the hint tier would collapse into the body-secondary tier. A light-skin design
  decision, not a token swap.
- **Remaining light failures are few and mostly not chrome:** `moba-light` 4 and
  `daylight` 5, worst being a `TypeError` string in an empty snippets panel (an
  artifact of running in a plain browser where every `invoke()` rejects) and the
  primary CTA at 3.53:1.
- **`default` measures 45 failures and `amber` 0.** Neither was measured before this
  batch. `.moba-tool-label` and `.moba-tool-caption` are **unchanged since
  `731afc5`**, so those are pre-existing, not regressions. Worth a separate pass if
  `default` matters, since it is the fallback skin.

## Verification

618 vitest across 54 files, green. `npm run build` clean. Runtime sweep across 6
skins with transitions disabled. Resolver diff of every touched site across all 14
skins: 0 dark changes.

One methodology note carried from the first runtime pass: measure with
`transition: none` forced. The Browser pane does not composite when hidden, so a
CSS colour transition can freeze mid-flight and `getComputedStyle` returns the
previous skin's value. That produced a false 1.93:1 reading earlier in this audit.
