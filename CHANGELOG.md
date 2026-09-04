# Changelog

All notable changes to `@anionex/dsh-apply-patch` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-09-04

### Fixed

- Accept pi-ai's singleton `input` fallback envelope as well as its configured
  `patch` envelope before restoring raw `apply_patch` arguments, preventing a
  provider fallback from terminating the full agent turn.

### Changed

- Remove native `write` and its system-prompt section alongside `edit` and
  `str_replace_editor` while replacement mode is active.

### Documentation

- Added CI, community health files, issue forms, bilingual project positioning,
  and repository-owned hero and social-preview assets.

## [0.1.3] - 2026-09-04

### Changed

- Kept model-visible guidance focused on the file-editing task and patch syntax,
  without transport or implementation background.

## [0.1.2] - 2026-09-04

### Added

- Added the official DSH keyed toolview and native diff card presentation.
- Added replayable per-hunk presentation metadata and Desktop alpha.1 client
  compatibility coverage.

## [0.1.1] - 2026-09-04

### Fixed

- Completed the Apache-2.0 license and NOTICE attribution for the pinned OpenAI
  Codex grammar, fixtures, and ported implementation.

## [0.1.0] - 2026-09-04

### Added

- Initial public release with raw OpenAI Responses custom-tool input, Codex
  patch parsing, ordered matching, full preflight, transactional application,
  rollback on handled failures, and unified diff output.

[Unreleased]: https://github.com/Anionex/dsh-apply-patch/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Anionex/dsh-apply-patch/releases/tag/v0.1.4
[0.1.3]: https://github.com/Anionex/dsh-apply-patch/releases/tag/v0.1.3
[0.1.2]: https://github.com/Anionex/dsh-apply-patch/releases/tag/v0.1.2
[0.1.1]: https://github.com/Anionex/dsh-apply-patch/releases/tag/v0.1.1
[0.1.0]: https://github.com/Anionex/dsh-apply-patch/releases/tag/v0.1.0
