export type PatchOperation = AddFileOperation | DeleteFileOperation | UpdateFileOperation;
export interface AddFileOperation {
    kind: 'add';
    path: string;
    content: string;
    line: number;
}
export interface DeleteFileOperation {
    kind: 'delete';
    path: string;
    line: number;
}
export interface UpdateFileOperation {
    kind: 'update';
    path: string;
    moveTo?: string;
    chunks: UpdateChunk[];
    line: number;
}
export interface UpdateChunk {
    changeContext?: string;
    oldLines: string[];
    newLines: string[];
    contextLineIndices: Array<readonly [oldIndex: number, newIndex: number]>;
    isEndOfFile: boolean;
    line: number;
}
export interface ParsedPatch {
    operations: PatchOperation[];
    normalizedPatch: string;
    environmentId?: string;
}
export interface AppliedFile {
    action: 'add' | 'delete' | 'update' | 'move';
    path: string;
    from?: string;
}
export interface PresentationDiff {
    path: string;
    oldText: string | null;
    newText: string;
}
export interface ApplyPatchResult {
    summary: string;
    diff: string;
    files: AppliedFile[];
    diffs: PresentationDiff[];
}
export interface ApplyPatchOptions {
    cwd: string;
    patch: string;
    signal?: AbortSignal;
    resolvePath?(path: string): string | Promise<string>;
    validatePath?(path: string, resolvedPath: string): void | Promise<void>;
    hooks?: ApplyPatchTestHooks;
}
/** Test-only fault hooks. Production callers should omit this object. */
export interface ApplyPatchTestHooks {
    afterStageOpen?(path: string, index: number): void | Promise<void>;
    beforeCommitPath?(path: string, index: number): void | Promise<void>;
    beforeVerify?(): void | Promise<void>;
    beforeDiff?(): void | Promise<void>;
}
