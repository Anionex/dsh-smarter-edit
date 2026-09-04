# Third-Party Notices

The freeform grammar in `third_party/codex/apply_patch.lark` and the conformance
fixtures in `tests/fixtures/codex-scenarios/` are copied from OpenAI Codex at
commit `8e6a44b428e31f91b21edc97904fcdf4f0931ade` under the Apache License 2.0.
The upstream license and applicable NOTICE attribution are included at
`third_party/codex/LICENSE` and `third_party/codex/NOTICE`.
The TypeScript parser and text-update implementation are ports of the same
revision's `streaming_parser.rs`, `file_update.rs`, `seek_sequence.rs`, and
`text_file.rs` mechanisms.

Sources:

- https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/assets/tools/apply_patch.lark
- https://github.com/openai/codex/tree/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/apply-patch/src
- https://github.com/openai/codex/tree/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/apply-patch/tests/fixtures/scenarios

OpenAI Codex copyright and license notices are available at:
https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/LICENSE
