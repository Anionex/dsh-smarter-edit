# Changelog

All notable changes to `@anionex/dsh-smarter-edit` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.6] - 2026-09-05

### Fixed

- Accept DeepSeek V4 Flash's singleton `arguments` fallback only when its value
  is raw patch text, preventing the bridge from terminating otherwise valid
  `apply_patch` calls while continuing to reject arbitrary or multi-field
  envelopes.
- Include recognized JSON field names and value types in bridge compatibility
  errors while redacting unknown field names and all values.

### Documentation

- Reworked the English and Chinese READMEs around exact-string replacement and
  JSON-format overhead, and moved transport and atomicity details into paired
  implementation documents.
- Clarified that rollback protects file state but does not bound the retry cost
  of a failed large patch.

## [0.1.5] - 2026-09-04

### Changed

- Renamed the project to DSH Smarter Edit, the npm package to
  `@anionex/dsh-smarter-edit`, and the GitHub repository to
  `Anionex/dsh-smarter-edit`.
- Marked the former `@anionex/dsh-apply-patch` package as deprecated so new
  installations move to the renamed package.

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

[Unreleased]: https://github.com/Anionex/dsh-smarter-edit/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.6
[0.1.5]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.5
[0.1.4]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.4
[0.1.3]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.3
[0.1.2]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.2
[0.1.1]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.1
[0.1.0]: https://github.com/Anionex/dsh-smarter-edit/releases/tag/v0.1.0
