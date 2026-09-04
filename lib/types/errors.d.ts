export type PatchErrorCode = 'PATCH_INVALID' | 'PATCH_PATH_INVALID' | 'PATCH_CONTEXT_NOT_FOUND' | 'PATCH_CONFLICT' | 'PATCH_IO' | 'PATCH_ROLLBACK_FAILED' | 'PATCH_ABORTED' | 'PATCH_UNSUPPORTED';
export declare class PatchError extends Error {
    readonly code: PatchErrorCode;
    readonly line?: number;
    constructor(message: string, code: PatchErrorCode, options?: ErrorOptions & {
        line?: number;
    });
}
export declare function patchErrorMessage(error: unknown): string;
