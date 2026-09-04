export class PatchError extends Error {
    code;
    line;
    constructor(message, code, options = {}) {
        super(message, options);
        this.name = 'PatchError';
        this.code = code;
        if (options.line !== undefined)
            this.line = options.line;
    }
}
export function patchErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
