# DSH Smarter Edit

[中文说明](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![License](https://img.shields.io/github/license/Anionex/dsh-smarter-edit?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Anionex/dsh-smarter-edit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Anionex/dsh-smarter-edit/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/npm/types/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![GitHub release](https://img.shields.io/github/v/release/Anionex/dsh-smarter-edit?style=flat-square&label=release)](https://github.com/Anionex/dsh-smarter-edit/releases)

**A better editing interface for DeepSeek Harness.**

DSH's native `edit` requires coding models to reconstruct exact source strings
and send both old and new code through structured JSON arguments.

DSH Smarter Edit replaces that interface with Codex-compatible freeform
`apply_patch`, allowing the model to express code changes directly as a diff.
Its goal is to reduce editing failures and token overhead created by the editor
protocol itself.

```diff
*** Begin Patch
*** Update File: src/app.ts
@@
-const result = oldMethod(value)
+const result = newMethod(value)
*** End Patch
```

The model describes the change instead of reconstructing an exact
`old_string` / `new_string` pair.

**Let the model spend its tokens on changing code, not satisfying the editor
protocol.**

![DSH Smarter Edit: a better editing interface for DeepSeek Harness](assets/hero.png)

## Why this exists

Coding models should solve one problem: what code should change. DSH's native
editing protocol adds three more.

### 1. Exact-string reconstruction

Native `edit(file_path, old_string, new_string)` asks the model to regenerate
source it has already read. The `old_string` must match the file:

```text
The model knows the correct code change
        ↓
old_string differs in whitespace, indentation, or characters
        ↓
The edit fails
```

That is a **protocol failure**, not a coding failure. Smarter Edit removes the
exact-string pair from the model-facing interface and lets contextual patch
hunks locate the change.

### 2. Source duplication

Exact-string editing makes the model output both the existing block and a new
block that often repeats most of it:

```text
old_string = existing source
new_string = mostly the same source + the change
```

A patch expresses the changed lines and only the context needed to locate them:

```diff
 required context
-before
+after
 required context
```

The intended token reduction comes from less repeated old source, less repeated
unchanged source, less JSON escaping, and fewer retries after exact-match
failures. The maintainers will not publish a percentage until controlled A/B
tests produce one.

### 3. Structured JSON overhead

The model must also encode multiline source inside a schema:

```json
{
  "old_string": "...",
  "new_string": "..."
}
```

Quoting, escaping, and the exact-match fields belong to the editor protocol,
not the code change. Freeform `apply_patch` lets the model generate the editing
language itself.

## Evidence from OpenAI

OpenAI moved `apply_patch` to a named freeform tool interface. Its
[official model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
reports that this change reduced `apply_patch` failure rates by **35% in
testing** compared with JSON-formatted function calling.

The result measures `apply_patch` call failures. It does not measure task
success, SWE-bench performance, or token savings. It shows that tool interface
design itself measurably affects editing reliability.

## Why read representation matters

Exact-string editing depends on the model seeing the same source representation
that the mutation tool matches. If a read layer adds line-number gutters,
changes tabs to spaces, or normalizes line endings while the edit tool matches
raw file contents, the model must reverse that transformation before every
edit.

Public Claude Code issue reports document this failure class:

- [#13152](https://github.com/anthropics/claude-code/issues/13152) reports tabs
  appearing as spaces in read output, followed by exact-match edit failures.
- [#28831](https://github.com/anthropics/claude-code/issues/28831) reports
  unreliable multiline matching on CRLF files with tab indentation and
  identifies read formatting as one possible cause.
- [#54876](https://github.com/anthropics/claude-code/issues/54876) reports LF
  read output against CRLF file contents.
- [#40471](https://github.com/anthropics/claude-code/issues/40471) reports a
  repeated edit-fail, retry, and Python/Bash fallback cycle on tab-indented
  files.

These are user-reported issues from another harness, not evidence about DSH's
read implementation. Smarter Edit addresses the editing side of the problem;
raw-source reading remains a separate harness concern.

## Additional capabilities

Besides replacing the model-facing editing protocol, Smarter Edit supports:

- multiple ordered hunks;
- multiple files in one patch;
- add, update, move, and delete operations;
- Codex-compatible contextual matching;
- failure-atomic preflight and rollback;
- native DSH diff rendering.

## Install

Install the current npm release into a Desktop Profile:

```sh
dsh plugin --profile desktop add @anionex/dsh-smarter-edit
```

Use `web` or `headless` instead of `desktop` for those Profiles. Restart the
running Profile and create a new Session after installation.

Verify that the bundle is mounted:

```sh
dsh --profile desktop --dump-config | grep tool-apply-patch
```

## How it works

1. The model sends one patch between `*** Begin Patch` and `*** End Patch`.
2. The parser builds an ordered operation plan. The host resolves each path
   through the active DSH sandbox.
3. The engine preflights the complete plan, stages replacement contents,
   commits targets, and verifies the result. A handled failure triggers
   reverse-order rollback.
4. The tool returns an operation summary, a canonical unified diff, and
   per-hunk presentation metadata.
5. DSH stores the raw patch in Session history. The bundled Web client registers
   through DSH's official keyed toolview slot and replays the native `DiffBlock`.

The plugin removes model-visible `edit`, `write`, and legacy
`str_replace_editor` plus their prompt sections while replacement mode is
active. Unloading it restores the original tool surface. The pure engine is
available from `@anionex/dsh-smarter-edit/engine`; the DSH adapter lives in
`src/host.ts` and `src/index.ts`.

## Compatibility and limitations

- DSH `>=0.1.1-rc.1 <0.2.0`.
- Node.js `^22.19.0 || >=24.0.0` for package development and direct engine use.
- `desktop`, `web`, and `headless` Profiles.
- OpenAI Responses through pi-ai for provider-wire raw custom-tool input.
  Anthropic Messages and Google Generative AI keep their ordinary JSON tool
  transport because those serializers do not expose a freeform custom-tool
  primitive.
- Write permission from the active DSH sandbox. `workspace-write` keeps its
  configured boundary; `danger-full-access` can allow absolute and
  parent-relative paths outside it.
- A broad patch can change or delete several files. Review the requested patch
  and the resulting diff when a change has a large scope.
- Historical calls without presentation metadata fall back to plain output
  instead of reconstructing a diff from untrusted text.

The project is pre-1.0. Compatibility targets the declared DSH `0.1.x` range;
release verification installs the tarball into a clean Profile.

## Codex compatibility

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
`third_party/codex/`; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

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

## Syntax

Supported operations:

```diff
*** Add File: relative/path.ts
+every added line starts with +
*** Delete File: relative/obsolete.ts
*** Update File: relative/current.ts
*** Move to: relative/renamed.ts
@@ optional function or section context
 unchanged context
-removed line
+added line
*** End of File
```

`Move to` is optional. `End of File` anchors its hunk to the file tail. A
pure-addition update hunk appends to the file. Relative paths resolve from the
Session working directory; absolute and parent-relative paths work when the
active DSH sandbox permits them. Repeated file sections run in patch order, so
each operation sees earlier operations in the same call. Add over an existing
file replaces it, matching Codex behavior.

## Configuration

Profile patch values, with defaults:

```yaml
- id: tool-apply-patch
  config:
    replaceNativeEdit: true
```

Set `replaceNativeEdit: false` only when you want `edit`, `write`, and
`str_replace_editor` alongside `apply_patch`. It does not change freeform
transport or transaction behavior.

## Benchmarking

The first planned A/B comparison uses DeepSeek V4 Flash on the same coding
fixtures with native DSH `edit` and DSH Smarter Edit. Each cohort must use the
same prompt, model settings, reasoning effort, sandbox, clean workspace
snapshot, and trial count.

| Metric | Definition |
| --- | --- |
| Mutation calls | File-mutation tool calls before completion |
| Mutation failure rate | Rejected or failed mutation calls / all mutation calls |
| Output tokens | Assistant output tokens for the full task |
| Rounds | Model request steps before the terminal answer |
| First-test pass | First test command exits zero |
| Final success | Every fixture acceptance check passes |
| Wall time | User request accepted to terminal result |

Reject a trial from the freeform cohort if the recorded provider request
describes `apply_patch` as `type: "function"`. A valid trial must show OpenAI
`type: "custom"` with `format.syntax: "lark"`. Publish measured results here
only after repeated controlled trials.

## Development

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
```

The test suite covers the official Codex corpus, parser and matcher behavior,
sandbox paths, preflight isolation, rollback faults, cleanup, concurrent
modification detection, tool registration, native-tool filtering, package
layout, raw DSH call reconstruction, native diff presentation, and captured
OpenAI request serialization.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior or packaging.

## Security and community

- Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
- Get usage help through [SUPPORT.md](SUPPORT.md).
- Propose changes through [CONTRIBUTING.md](CONTRIBUTING.md) and the
  [issue tracker](https://github.com/Anionex/dsh-smarter-edit/issues).
- Read release history in [CHANGELOG.md](CHANGELOG.md).
- Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Maintained by [Anionex](https://github.com/Anionex) under the
[MIT License](LICENSE).
