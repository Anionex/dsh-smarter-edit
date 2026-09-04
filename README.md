# DSH Smarter Edit

[中文说明](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![License](https://img.shields.io/github/license/Anionex/dsh-smarter-edit?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Anionex/dsh-smarter-edit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Anionex/dsh-smarter-edit/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/npm/types/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![GitHub release](https://img.shields.io/github/v/release/Anionex/dsh-smarter-edit?style=flat-square&label=release)](https://github.com/Anionex/dsh-smarter-edit/releases)

**One ordered, atomic, reviewable `apply_patch` call for multi-file edits in DeepSeek Harness.**

DSH Smarter Edit replaces the model-visible native `edit` and `write` tools, plus legacy `str_replace_editor`, with a Codex-compatible `apply_patch` tool. Models can add, update, move, and delete files across ordered hunks. The plugin preflights the whole patch, rolls back handled failures, and renders the result with DSH's native diff UI.

![DSH Smarter Edit: one ordered, atomic apply_patch call for multi-file edits](assets/hero.png)

## Features

- **Change related files in one call.** One patch can add, update, move, and delete files with multiple ordered hunks.
- **Keep handled failures atomic.** The engine parses, resolves, preflights, stages, commits, and verifies every operation. A detected failure rolls published targets back in reverse order.
- **Send raw patch text on OpenAI Responses.** The model emits `*** Begin Patch` content as custom-tool input. Session logs and the Trajectory parameter view keep that raw text.
- **Review edits in the conversation.** Each successful call returns a unified diff and structured presentation metadata. The bundled Web client registers through DSH's official keyed toolview slot and uses the native `DiffBlock`.
- **Match Codex patch behavior.** The grammar matches the pinned Codex revision byte for byte. Tests run its 25-scenario portable corpus and document the single transactional difference.
- **Install as a standard DSH bundle.** The package supports `desktop`, `web`, and `headless` Profiles, and unloading it restores the original file-mutation tools.

## Quick start

Install the current npm release into a Desktop Profile:

```sh
dsh plugin --profile desktop add @anionex/dsh-smarter-edit
```

Use `web` or `headless` instead of `desktop` for those Profiles. Restart the running Profile and create a new Session after installation.

The model then edits files with raw patch text:

```diff
*** Begin Patch
*** Update File: src/app.ts
@@
-old code
+new code
*** Add File: src/utils.ts
+export const ready = true
*** Delete File: src/legacy.ts
*** End Patch
```

Verify that the bundle is mounted:

```sh
dsh --profile desktop --dump-config | grep tool-apply-patch
```

## Compared with native edit

| Capability | `apply_patch` | Native `edit` |
| --- | --- | --- |
| Multi-file and multi-hunk changes | One ordered call | One exact replacement per call |
| Matching | Ordered context with whitespace and Unicode-punctuation fallback | Exact `old_string` match |
| Review output | Unified diff, operation summary, and native DSH diff card | Native DSH diff card |
| Handled multi-file failure | Full preflight and rollback | Each completed call is already committed |
| Model token overhead | Often lower for related edits; patch syntax adds markers | Often lower for one tiny exact replacement |
| Model transport | Raw OpenAI custom-tool input through pi-ai | Ordinary JSON function arguments |
| Main tradeoff | A broad patch can change or delete several files at once | Narrower blast radius; complex edits require more calls |

## Use cases

- Apply one cross-file change whose files must succeed or fail together.
- Match an ordered code context when one exact whole-string replacement would be brittle.
- Add, rename, and remove files as part of the same edit.
- Preserve a replayable raw patch while showing a native diff card in the conversation.

## How it works

1. The model sends one patch between `*** Begin Patch` and `*** End Patch`.
2. The parser builds an ordered operation plan. The host resolves each path through the active DSH sandbox.
3. The engine preflights the complete plan, stages replacement contents, commits targets, and verifies the result. A handled failure triggers reverse-order rollback.
4. The tool returns an operation summary, a canonical unified diff, and per-hunk presentation metadata.
5. DSH stores the raw patch in Session history. The Web client uses the presentation metadata to replay the native diff card.

The pure engine is exported from `@anionex/dsh-smarter-edit/engine` and has no Cordis dependency. The DSH adapter stays in `src/host.ts` and `src/index.ts`.

## Guarantees

- Parses and validates the entire patch before mutating any target.
- Locates update hunks with Codex-compatible exact, trailing-whitespace, full-whitespace, and Unicode-punctuation matching passes.
- Uses Codex's `PreserveLineEndings` mode: context lines keep their endings, inserted lines use the first existing ending, and updates retain Codex's historical trailing-newline behavior.
- Resolves relative paths from the Session working directory, accepts absolute paths, and follows symbolic links; DSH's active sandbox remains the permission boundary.
- Stages every new file body before commit, publishes without clobbering a concurrently created path, validates atomically captured backups, verifies final contents, and rolls back already-published targets in reverse order after an ordinary detected failure.
- Returns a canonical unified diff and an operation summary.
- Registers its conversation row through DSH's official keyed toolview slot and renders applied metadata with the native `DiffBlock`.
- Removes native `edit`, native `write`, and legacy `str_replace_editor` from the assembled model tool list, and removes their prompt sections, while the plugin is active. Unloading the plugin restores the original surface.

The transaction is **failure-atomic**, not a crash-safe filesystem transaction. A handled parse, preflight, stage, commit, or verification failure leaves no partial target changes when rollback succeeds. Process termination, kernel failure, power loss, or a rollback I/O failure can still leave recovery files; no general host filesystem provides a crash-atomic multi-file transaction.

## Compatibility and status

- DSH `>=0.1.1-rc.1 <0.2.0`.
- Node.js `^22.19.0 || >=24.0.0` for package development and direct engine use.
- `desktop`, `web`, and `headless` Profiles.
- A pi-ai OpenAI Responses route when provider-wire raw custom-tool input is required. Other adapters retain their native tool protocol.
- Write permission from the active DSH sandbox. `workspace-write` keeps its configured boundary; `danger-full-access` can permit absolute and parent-relative paths outside it.
- The project is pre-1.0. Compatibility targets the declared DSH `0.1.x` range; release verification installs the tarball into a clean Profile.

## Limitations

- One broad patch can modify or delete several files. Review the requested patch and the resulting diff when the change has a large scope.
- Native `edit` can cost fewer tokens for one tiny exact replacement.
- Anthropic Messages and Google Generative AI routes use their ordinary JSON tool transport because those pi-ai serializers do not expose provider-wire raw custom-tool input.
- The failure-atomic guarantee covers detected errors and successful rollback. It does not cover process termination, power loss, kernel failure, or rollback I/O failure.
- Historical successful calls created without presentation metadata fall back to plain output instead of reconstructing a diff from untrusted text.

## Codex alignment

The grammar is byte-identical to OpenAI Codex commit `8e6a44b428e31f91b21edc97904fcdf4f0931ade`. The parser state machine, ordered replacement computation, four-pass sequence matching, context-line handling, and `PreserveLineEndings` reconstruction are TypeScript ports of that revision. The complete 25-scenario official corpus runs in tests: 24 match upstream final state exactly, and scenario 015 asserts the documented transactional difference.

The one intentional execution difference is failure handling: upstream scenario 015 preserves earlier writes after a later operation fails, while this plugin preflights all operations and rolls them back to satisfy DSH's requested failure-atomic contract. This wrapper does not change the patch grammar or successful file contents permitted by the active DSH sandbox.

The project license is MIT. Codex-derived grammar, fixtures, and ported implementation retain their Apache-2.0 license and NOTICE attribution under `third_party/codex/`; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Freeform transport

DSH `0.1.x` exposes only JSON-schema tool definitions and strips custom-tool metadata before the provider adapter. This plugin installs a narrow, reference-counted bridge at `PiAiAdapter.current()`, the request-frozen model snapshot boundary shared by supported alpha and rc builds, and enriches only the exact `apply_patch` schema with the bundled OpenAI Lark grammar.

On pi-ai OpenAI Responses routes, the bridge selects grammar custom-tool transport without requiring a model capability flag. The provider request contains an OpenAI `type: "custom"` tool with raw input. Other provider protocols that have no freeform custom-tool primitive use their ordinary JSON tool transport; the plugin does not disable those models.

DSH's public `llm/stream` middleware removes pi-ai's temporary single-property envelope before DSH assembles, executes, or persists a completed tool call. A replay bridge restores that envelope only inside the adapter when a later model step replays raw Session history. Live completed arguments, Session logs, and the Trajectory parameter view therefore contain raw patch text without breaking the following model step.

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

`Move to` is optional. `End of File` anchors its hunk to the file tail. A pure-addition update hunk appends to the file. Relative paths resolve from the Session working directory; absolute paths and parent-relative paths are accepted when the active DSH sandbox allows them. Repeated file sections are evaluated in patch order, so each operation sees earlier operations in the same call. Add over an existing file replaces it, matching Codex behavior.

## Configuration

Profile patch values, with defaults:

```yaml
- id: tool-apply-patch
  config:
    replaceNativeEdit: true
```

Set `replaceNativeEdit: false` only when intentionally exposing `edit`, `write`, and `str_replace_editor` alongside `apply_patch`. It does not change freeform transport or transaction behavior.

## Development

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
```

The tests run the complete official Codex portable scenario corpus, focused parser and matcher cases, sandbox path cases, preflight isolation, rollback after injected faults, cleanup, concurrent modification detection, registration, native-edit filtering, package layout, raw DSH call reconstruction, native diff-card presentation, and captured OpenAI request serialization.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior or packaging.

<details>
<summary>A/B benchmark contract</summary>

Use identical task fixtures, model settings, sandbox mode, prompt text, clean workspace snapshots, and trial counts. Compare native `edit` against `apply_patch` on:

| Metric | Definition |
| --- | --- |
| Tool calls | Total mutation-tool calls before completion |
| Failure rate | Rejected mutation calls / all mutation calls |
| Output tokens | Assistant output tokens for the full task |
| Rounds | Model request steps before terminal answer |
| First-test pass | First test command exits zero |
| Final success | Fixture acceptance checks all pass |
| Wall time | User request accepted to terminal result |

Reject a trial from the freeform cohort if the recorded provider request describes `apply_patch` as `type: "function"`; valid trials must show OpenAI `type: "custom"` with `format.syntax: "lark"`.

</details>

## Security and community

- Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
- Get usage help through [SUPPORT.md](SUPPORT.md).
- Propose changes through [CONTRIBUTING.md](CONTRIBUTING.md) and the [issue tracker](https://github.com/Anionex/dsh-smarter-edit/issues).
- Read release history in [CHANGELOG.md](CHANGELOG.md).
- Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Maintained by [Anionex](https://github.com/Anionex) under the [MIT License](LICENSE).
