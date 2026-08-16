# Contributing to Pluto's Terminal

Thanks for considering a contribution. The project is run by
[@plutothedev](https://github.com/plutothedev) and the
[Pluto community](https://discord.gg/yy9QCnUsde). Bug reports, feature
suggestions, and code PRs are all welcome.

## Ways to contribute

1. **Report a bug** using the bug-report issue template. Include your OS and the
   app version (bottom-left of the status bar).
2. **Suggest a feature** using the feature-request template.
3. **Ship code:** pick an open issue or propose a change in an issue first, so
   nobody builds something that won't be merged.

## Dev setup

```bash
git clone https://github.com/plutothedev/plutos-terminals.git
cd plutos-terminals
npm install
npm run tauri dev    # dev app with hot reload (Vite + cargo build)
```

**Prerequisites:** Node.js LTS, Rust 1.77+ (via [rustup](https://rustup.rs/)),
and on Windows the Visual Studio Build Tools 2019+. The first `cargo` build is
slow because Tauri pulls many crates; later builds are incremental.

Fast compile checks without launching the app:

```bash
npm run build                  # frontend compile check
cd src-tauri && cargo check    # backend compile check
```

## Test gates

Both must be green before a PR is ready:

```bash
npx vitest run                 # JS/JSX unit tests
cd src-tauri && cargo test     # Rust unit tests
```

New behavior should come with tests. Frontend tests default to the node
environment; a test that needs the DOM declares happy-dom via the
`@vitest-environment` pragma on its first line.

## PR expectations

- Small, focused PRs merge fastest. One concern per PR.
- Describe what changed and why; link the issue it closes.
- `npx vitest run` and `npm run build` green, plus `cargo test` if you touched
  Rust.
- No new dependencies without prior discussion in an issue.
- Expect review feedback; the codebase carries invariants (PTY lifetimes,
  keychain-backed secrets, functional state updaters) that reviews enforce.

## Code style

- Functional React components + hooks; no class components. Keep components
  focused and split them when they grow.
- Inline styles consume the `--phn-*` design tokens from `headerSkins.js`; no
  CSS-in-JS framework.
- Use `useToast()` / `useConfirm()` instead of `window.alert` / `window.confirm`.
- Tauri commands: snake_case in Rust, camelCase in JS invoke calls. New blocking
  Rust commands must be `async fn`.
- See `CLAUDE.md` for the architecture map and the cross-cutting invariants.

## License

Pluto's Terminal is proprietary, source-available software (see
[LICENSE](LICENSE)). By submitting a PR you agree that your contribution is
licensed to the project's copyright holder under the project license.
