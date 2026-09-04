export type PatchErrorCode =
  | 'PATCH_INVALID'
  | 'PATCH_PATH_INVALID'
  | 'PATCH_CONTEXT_NOT_FOUND'
  | 'PATCH_CONFLICT'
  | 'PATCH_IO'
  | 'PATCH_ROLLBACK_FAILED'
  | 'PATCH_ABORTED'
  | 'PATCH_UNSUPPORTED'

export class PatchError extends Error {
  readonly code: PatchErrorCode
  readonly line?: number

  constructor(message: string, code: PatchErrorCode, options: ErrorOptions & { line?: number } = {}) {
    super(message, options)
    this.name = 'PatchError'
    this.code = code
    if (options.line !== undefined) this.line = options.line
  }
}

export function patchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
