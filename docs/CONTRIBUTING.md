# Contributing

Thanks for helping with dsh-ops. This guide covers the development conventions,
the verification gate and the pull-request flow for this repository.

## Contents

- [Development environment](#development-environment)
- [Verification gate](#verification-gate)
- [Code and documentation conventions](#code-and-documentation-conventions)
- [Commits and pull requests](#commits-and-pull-requests)
- [Hard boundaries](#hard-boundaries)
- [License and attribution](#license-and-attribution)

## Development environment

| Component | Requirement |
| --- | --- |
| Node.js | `^22.19` or `>=24` (see `package.json#engines`) |
| Rust | only when touching `native/` or `vendor/fastctx/`; toolchain `1.97.1` |
| Target host | DSH `0.2.0-rc.2` |

```console
npm install
npm run verify
```

## Verification gate

`npm run verify` is the single gate and runs two checks:

1. `node scripts/validate-manifest.mjs` — parses and projects `dsh-plugin.json`
   with the pinned `@dsh-std/manifest` version, then verifies the facts the
   repository states about itself (version/license, entry points, tool
   namespaces, the `package.json#files` whitelist, ...).
2. `node test/run.mjs` — every `test/*.test.mjs` in its own process with its own
   temporary `DSH_HOME`.

**New behaviour needs assertions.** Mount-related changes must be falsifiable in
`test/mount.test.mjs`. Make sure `npm run verify` is green locally before you
open a pull request.

## Code and documentation conventions

- **Language**: code, comments, CLI output and commit messages are English.
  User-facing docs are bilingual; maintainer notes are Chinese.
- **Doc naming**: keep an English/Chinese pair under `docs/`, e.g.
  `docs/usage.md` and `docs/使用指南.md`.
- **Tool names**: always derive them through `publicToolName()` in
  `lib/policy.js`; do not hand-write the `ops_` prefix.
- **Config validation**: lives in `lib/config.js`; unknown keys must fail and be
  named. Defaults in `cordis.patch.yml` must match the code defaults.
- **Resolution and probing**: run synchronously inside `apply`; `required: true`
  must refuse activation at load time.

## Commits and pull requests

- Keep commits small. Use an English imperative message, e.g.
  `fix: report undeclared background arguments as argument errors (#14)`.
- Use a real author identity; do not pad history, forge attribution or rewrite
  pushed history.
- Open an issue first for larger changes. Describe the motivation, the blast
  radius and how you verified the change.
- GitHub Actions is disabled for this repository by default; the maintainer
  enables CI runs on demand.

## Hard boundaries

- The host half **must not import `@deepseek-ai/*` values at load time**; use
  `ctx.inject([...])` / `ctx.get()` when you need host services.
- **Never replace the shared tool registry**: publish `ops_*` tools only through
  this plugin's own `ctx.tools.register`.
- Read prompt-section values with `ctx.get('tools')`, not `ctx.tools`.
- Changes under `vendor/fastctx/` are deletions only; a real `src/` change needs
  an Apache-2.0 §4(b) header and an entry in `vendor/fastctx/FORK.md`.
- Do not delete a tool's contract (argument semantics, defaults, path base,
  pagination completeness, permission boundaries) to shrink schema or prompt
  bytes.

## License and attribution

The plugin is MIT outside `vendor/fastctx/`; `vendor/fastctx/` is Apache-2.0.
The verbatim notice upstream requires in `NOTICE` and both READMEs **must stay
byte-for-byte**; do not "polish" it.

For native build and acceptance details, see [native-ptc.md](native-ptc.md) and
[manual-validation.md](manual-validation.md).
