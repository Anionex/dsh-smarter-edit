import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "@anionex/dsh-apply-patch";
export declare const inject: string[];
export interface Config {
    /** Remove native file-mutation schemas and guidance while this plugin is active. */
    replaceNativeEdit?: boolean;
}
export declare const Config: z<Config>;
/** Accept the restored raw transport and the legacy envelope for compatibility. */
export declare function applyPatchText(args: unknown): string;
/** Register the freeform patch tool and its reversible native-edit replacement surface. */
export declare function apply(ctx: Context, config: Config): Promise<void>;
export * from './engine.js';
export * from './errors.js';
export * from './freeform-bridge.js';
export * from './host.js';
export * from './matcher.js';
export * from './parser.js';
export * from './source-file.js';
export * from './types.js';
