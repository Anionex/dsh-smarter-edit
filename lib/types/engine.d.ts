import type { ApplyPatchOptions, ApplyPatchResult, ParsedPatch } from './types.js';
/** Return every source or destination path a parsed patch intends to mutate. */
export declare function mutationPaths(parsed: ParsedPatch): string[];
/** Parse, preflight, stage, atomically publish, verify, and summarize one patch. */
export declare function applyPatchAtomic(options: ApplyPatchOptions): Promise<ApplyPatchResult>;
export { parsePatch } from './parser.js';
export { applyChunks, seekSequence } from './matcher.js';
export { PatchError } from './errors.js';
export type * from './types.js';
