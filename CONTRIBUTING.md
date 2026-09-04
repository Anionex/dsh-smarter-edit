# Contributing

Thanks for helping improve DSH Smarter Edit. It is a DeepSeek Harness (DSH)
plugin bundle with TypeScript source in `src/`, committed runtime artifacts in
`lib/`, a profile patch in `cordis.patch.yml`, and tests in `tests/`.

## Setup

Prerequisites:

- Node.js matching the `engines` field in `package.json`;
- pnpm `11.7.0` or a compatible pnpm 11 release.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

`pnpm run build` rebuilds the server modules, declarations, and loader-compatible
Web client artifact. `pnpm run check` runs type checking, both builds, the test
suite, and `pnpm pack --dry-run`.

## Before you start

Open an issue before changing public behavior so the contract can be agreed.
Parser changes must remain aligned with the pinned Codex revision and its
scenario corpus. The documented transactional rollback behavior is the one
intentional compatibility difference.

Keep changes scoped. Do not add machine-local paths, Profile state, generated
experiments, credentials, or registry tokens. The repository intentionally
commits `lib/`; rebuild and commit it whenever source changes affect runtime
artifacts.

## Pull requests

Before opening a pull request:

- run `pnpm peers check` and `pnpm run check` from a clean checkout;
- add focused tests for changed behavior;
- rebuild and commit affected `lib/` artifacts;
- update both `README.md` and `README.zh.md` for user-visible changes;
- add a concise entry under `[Unreleased]` in `CHANGELOG.md`;
- run `git diff --check` and review the package produced by `pnpm pack --dry-run`.

Do not include secrets, private source code, absolute machine paths, or local
DSH Profile state in issues, fixtures, snapshots, or pull requests.
