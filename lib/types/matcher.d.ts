import type { UpdateChunk } from './types.js';
/** Direct port of Codex apply-patch's seek_sequence in PreserveLineEndings mode. */
export declare function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, atEnd: boolean): number | undefined;
/** Derive one updated file in memory using Codex PreserveLineEndings semantics. */
export declare function applyChunks(content: string, path: string, chunks: readonly UpdateChunk[]): string;
