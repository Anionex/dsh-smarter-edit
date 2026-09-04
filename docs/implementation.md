# Implementation Notes

[中文](implementation.zh.md) | [Back to README](../README.md)

This document records implementation details that are useful for maintainers
and reviewers but are not required for installing or evaluating DSH Smarter
Edit.

## Codex alignment

The grammar is byte-identical to OpenAI Codex commit
`8e6a44b428e31f91b21edc97904fcdf4f0931ade`. The parser state machine, ordered
replacement computation, four-pass sequence matching, context-line handling,
and `PreserveLineEndings` reconstruction are TypeScript ports of that revision.

Tests run the complete 25-scenario official portable corpus. Twenty-four
scenarios match the upstream final state exactly. Scenario 015 asserts the one
intentional difference: upstream keeps earlier writes when a later operation
fails, while this plugin preflights all operations and rolls back published
targets.

The project uses the MIT License. Codex-derived grammar, fixtures, and ported
implementation retain their Apache-2.0 license and NOTICE attribution under
`third_party/codex/`; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Safety and atomicity

- Parses and validates the complete patch before mutating a target.
- Locates update hunks with Codex-compatible exact, trailing-whitespace,
  full-whitespace, and Unicode-punctuation matching passes.
- Uses Codex's `PreserveLineEndings` mode. Context lines keep their endings,
  inserted lines use the first existing ending, and updates retain Codex's
  historical trailing-newline behavior.
- Resolves relative paths from the Session working directory, accepts absolute
  paths, and follows symbolic links. DSH's active sandbox remains the permission
  boundary.
- Stages every new file body before commit, avoids clobbering a concurrently
  created path, captures and validates backups, verifies final contents, and
  rolls published targets back in reverse order after a detected failure.
- Returns a canonical unified diff and operation summary.

The transaction is **failure-atomic**, not crash-atomic. A handled parse,
preflight, stage, commit, or verification failure leaves no partial target
changes when rollback succeeds. Process termination, kernel failure, power
loss, or rollback I/O failure can still leave recovery files.

Failure atomicity does not bound retry cost. Any failed operation rejects the
whole patch, and a retry must submit the full patch again. The plugin imposes no
fixed patch-size limit, so this cost grows with the size of the patch.

## Freeform transport

DSH `0.1.x` exposes JSON-schema tool definitions and strips custom-tool metadata
before the provider adapter. This plugin installs a narrow, reference-counted
bridge at `PiAiAdapter.current()`, the request-frozen model snapshot boundary,
and enriches only the exact `apply_patch` schema with the bundled OpenAI Lark
grammar.

On pi-ai OpenAI Responses routes, the provider request contains an OpenAI
`type: "custom"` tool with raw input. Other provider protocols retain their
ordinary JSON tool transport.

DSH's public `llm/stream` middleware removes pi-ai's temporary single-property
envelope before DSH assembles, executes, or persists a completed call. A replay
bridge restores that envelope only inside the adapter when a later model step
replays raw Session history. Live arguments, Session logs, and the Trajectory
parameter view therefore contain raw patch text.

## Package entry points and presentation

The pure engine is available from `@anionex/dsh-smarter-edit/engine`. The DSH
adapter lives in `src/host.ts` and `src/index.ts`.

Each successful call returns an operation summary, a canonical unified diff,
and per-hunk presentation metadata. The bundled Web client registers through
DSH's official keyed toolview slot and renders the native `DiffBlock`.
Historical calls without presentation metadata fall back to plain output
instead of reconstructing a diff from untrusted text.
