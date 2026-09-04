# DSH Apply Patch

[中文说明](README.zh.md)

A portable DeepSeek Harness Profile Bundle that replaces the model-visible native `edit(file_path, old_string, new_string)` tool with a Codex-compatible `apply_patch` tool. OpenAI Responses routes through pi-ai use provider-native freeform custom-tool transport.

On that route, the model sends the patch as raw custom-tool input, not as a JSON object:

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

One call can add, update, move, and delete multiple files with multiple ordered hunks.

## Compared with native edit

| Capability | `apply_patch` | Native `edit` |
| --- | --- | --- |
| Multi-file and multi-hunk changes | One ordered call | One exact replacement per call |
| Matching | Ordered context with whitespace and Unicode-punctuation fallback | Exact `old_string` match |
| Review output | Unified diff, operation summary, and native DSH diff card | Native DSH diff card |
| Handled multi-file failure | Full preflight and rollback | Each completed call is already committed |
| Model token overhead | Usually lower for related edits; patch syntax adds markers | Usually lower for one tiny exact replacement |
| Model transport | Raw OpenAI custom-tool input through pi-ai | Ordinary JSON function arguments |
| Main tradeoff | A broad patch can change or delete several files at once | Narrower blast radius, but complex edits require more calls |

## Codex alignment

The grammar is byte-identical to OpenAI Codex commit `8e6a44b428e31f91b21edc97904fcdf4f0931ade`. The parser state machine, ordered replacement computation, four-pass sequence matching, context-line handling, and `PreserveLineEndings` reconstruction are TypeScript ports of that revision. The complete 25-scenario official corpus runs in tests: 24 match upstream final state exactly, and scenario 015 asserts the documented transactional difference.

The one intentional execution difference is failure handling: upstream scenario 015 preserves earlier writes after a later operation fails, while this plugin preflights all operations and rolls them back to satisfy DSH's requested failure-atomic contract. This wrapper does not change the patch grammar or successful file contents permitted by the active DSH sandbox.

## Guarantees

- Parses and validates the entire patch before mutating any target.
- Locates update hunks with Codex-compatible exact, trailing-whitespace, full-whitespace, and Unicode-punctuation matching passes.
- Uses Codex's `PreserveLineEndings` mode: context lines keep their endings, inserted lines use the first existing ending, and updates retain Codex's historical trailing-newline behavior.
- Resolves relative paths from the Session working directory, accepts absolute paths, and follows symbolic links; DSH's active sandbox remains the permission boundary.
- Stages every new file body before commit, publishes without clobbering a concurrently created path, validates atomically captured backups, verifies final contents, and rolls back already-published targets in reverse order after an ordinary detected failure.
- Returns a canonical unified diff and an operation summary.
- Registers its conversation row through DSH's official keyed toolview slot and renders applied metadata with the native `DiffBlock`.
- Removes native `edit` and legacy `str_replace_editor` from the assembled model tool list, and removes the native edit prompt section, while this plugin is active; unloading the plugin restores the original surface.

The transaction is **failure-atomic**, not a crash-safe filesystem transaction. A handled parse, preflight, stage, commit, or verification failure leaves no partial target changes when rollback succeeds. Process termination, kernel failure, power loss, or a rollback I/O failure can still leave recovery files; no general host filesystem provides a crash-atomic multi-file transaction.

## Freeform transport

DSH `0.1.x` exposes only JSON-schema tool definitions and strips custom-tool metadata before the provider adapter. This plugin installs a narrow, reference-counted bridge at `PiAiAdapter.current()`, the request-frozen model snapshot boundary shared by supported alpha and rc builds, and enriches only the exact `apply_patch` schema with the bundled OpenAI Lark grammar.

On pi-ai OpenAI Responses routes, the bridge selects grammar custom-tool transport without requiring a model capability flag. The provider request contains an OpenAI `type: "custom"` tool with raw input. Other provider protocols that have no freeform custom-tool primitive use their ordinary JSON tool transport; the plugin does not disable those models. In particular, pi-ai's Anthropic Messages and Google Generative AI serializers cannot provide provider-wire raw custom-tool input.

DSH's public `llm/stream` middleware removes the temporary single-property envelope before DSH assembles, executes, or persists a completed tool call. A pi-ai replay bridge restores that envelope only inside the adapter when a later model step replays raw Session history. Live completed arguments, Session logs, and the Trajectory parameter view therefore contain raw patch text without breaking the following model step.

## Install

From a checkout:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm pack

dsh plugin --profile web add ./anionex-dsh-apply-patch-0.1.2.tgz
dsh --profile web --dump-config | grep tool-apply-patch
```

For a published package, installation is one command:

```sh
dsh plugin --profile desktop add @anionex/dsh-apply-patch
dsh plugin --profile web add @anionex/dsh-apply-patch
dsh plugin --profile headless add @anionex/dsh-apply-patch
```

Restart a running Profile and create a new Session after changing the bundle list.

## Runtime requirements

- DSH `>=0.1.1-rc.1 <0.2.0`.
- A pi-ai OpenAI Responses route when provider-wire freeform custom-tool transport is required. Other adapters retain their native tool protocol.
- Write access under the active DSH sandbox. `workspace-write` keeps its normal workspace boundary; `danger-full-access` permits absolute and parent-relative paths outside it.

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

Set `replaceNativeEdit: false` only when intentionally exposing `edit`/`str_replace_editor` alongside `apply_patch`. It does not change freeform transport or transaction behavior.

## A/B benchmark contract

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

## Development

```sh
pnpm peers check
pnpm run check
```

The tests run the complete official Codex portable scenario corpus (24 exact outcomes plus the intentional scenario 015 rollback difference), plus focused parser/matcher cases, absolute/parent-relative/symlink paths, preflight isolation, rollback after an injected mid-commit fault, staged-directory cleanup, concurrent modification detection, registration, reversible native-edit filtering, package layout, raw DSH call reconstruction, and a captured pi-ai OpenAI request body proving custom-tool wire serialization.

The pure engine is exported from `@anionex/dsh-apply-patch/engine`; it has no Cordis dependency. The DSH adapter is isolated in `src/host.ts` and `src/index.ts`.
