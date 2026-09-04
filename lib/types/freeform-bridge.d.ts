export declare const APPLY_PATCH_TOOL_NAME = "apply_patch";
interface PiToolLike {
    name?: unknown;
    parameters?: unknown;
    constrainedSampling?: unknown;
    [key: string]: unknown;
}
interface PiContextLike {
    tools?: PiToolLike[];
    [key: string]: unknown;
}
interface ModelsLike {
    streamSimple(model: unknown, context: PiContextLike, options: unknown): unknown;
    [key: PropertyKey]: unknown;
}
interface SnapshotLike {
    models: ModelsLike;
    [key: string]: unknown;
}
/** Recover one raw custom-tool input from pi-ai's required JSON execution envelope. */
export declare function unwrapApplyPatchArguments(serialized: string): string;
/** Restore raw durable calls to pi-ai's internal grammar-tool envelope for replay. */
export declare function rewrapApplyPatchHistory(options: unknown): unknown;
/**
 * Restore raw apply_patch input before DSH assembles or persists the ToolCallBlock.
 * Other chunks retain object identity; apply_patch deltas and final blocks are cloned.
 */
export declare function unwrapApplyPatchStream<T>(source: AsyncIterable<T>): AsyncGenerator<T>;
/** Add pi-ai grammar metadata only to this plugin's single-string tool schema. */
export declare function withApplyPatchGrammar(context: PiContextLike, grammar: string): PiContextLike;
/** Wrap one pi-ai snapshot without mutating its immutable Models collection. */
export declare function bridgeSnapshot(snapshot: SnapshotLike, grammar: string): SnapshotLike;
/**
 * Upgrade pi-ai's apply_patch function schema to an OpenAI custom grammar tool.
 * DSH strips constrained-sampling metadata before pi-ai, so the bridge wraps
 * the adapter's request-frozen Models snapshot shared by alpha and rc builds.
 */
export declare function installPiAiFreeformBridge(): Promise<() => void>;
export {};
