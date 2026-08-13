---
name: release-notes
description: Draft community-facing release notes for Pluto's Terminal from the git history since the last tag. User-invoked only.
disable-model-invocation: true
---

<!-- (C) -->

# Release notes for Pluto's Terminal

Draft release notes for the next version. Pluto's Terminal ships as a **free, proprietary-licensed download for the Pluto community** (Discord, audience, social), so notes are friendly and player-facing — what users get, not internal refactors.

## Steps

1. **Find the range.** Last tag: `git describe --tags --abbrev=0`. Commits since: `git log <lasttag>..HEAD --oneline`.
2. **Read the current version** in `package.json` (`version`) and confirm `src-tauri/tauri.conf.json` matches. If they differ, flag it — the build embeds `tauri.conf.json`.
3. **Group commits by their conventional prefix** (the repo uses `feat:`, `fix:`, `revert:`, etc.):
   - `feat:` → **New** (lead with these — they're what the community cares about)
   - `fix:` → **Fixed**
   - `revert:` / chore / build / refactor → fold into a short **Under the hood** line or omit if purely internal.
4. **Rewrite each line for a non-developer.** "feat: multi-LLM provider picker (Hermes-style ~40 models, BYO key)" → "Pick from ~40 AI models (bring your own key)." Drop file names, ticket refs, and the `(C)` marker talk.
5. **Suggest the next version** per semver against the previous tag: any `feat:` → minor bump; only `fix:` → patch bump. State the suggestion; the user decides.

## Output format

```markdown
## Pluto's Terminal v<next-version>

### New
- <feature, one friendly line each>

### Fixed
- <fix, one friendly line each>

### Under the hood
- <one line, only if worth mentioning>

---
Free download • MIT licensed • built for the Pluto community
```

Keep it tight. If there are no user-facing changes since the last tag, say so instead of padding. Do not bump the version in any file or create a git tag — only draft the notes.
