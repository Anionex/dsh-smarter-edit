import type { ParsedPatch } from './types.js';
/** Parse complete input using the same states and leniency as Codex StreamingPatchParser. */
export declare function parsePatch(input: string): ParsedPatch;
