import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
type ApplyPatchRowProps = ToolCallViewProps & PropsLocale<'conversation'>;
export declare function ApplyPatchRow({ callId, block, openFile, inspect, t, }: ApplyPatchRowProps): import("react/jsx-runtime").JSX.Element;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export {};
