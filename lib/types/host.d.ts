import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ApplyPatchResult } from './types.js';
/** Execute one patch while leaving path and observation policy to the active DSH runtime. */
export declare function runApplyPatch(ctx: Context, patch: string, exec: ToolRunContext): Promise<ApplyPatchResult>;
