import { FsError } from '@deepseek-ai/dsh-fs';
import { sandboxDenialMarker, writableRoots } from '@deepseek-ai/dsh-sandbox';
import { applyPatchAtomic } from './engine.js';
import { PatchError } from './errors.js';
function policyFor(ctx, exec) {
    if (ctx.fs.sandboxMode === undefined)
        return undefined;
    const policy = ctx.get('sandboxPolicy');
    if (policy === undefined) {
        throw new PatchError('dsh-smarter-edit: sandboxed filesystem requires ctx.sandboxPolicy', 'PATCH_UNSUPPORTED');
    }
    return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
}
async function enforceSandbox(ctx, path, cwd, exec, policy) {
    if (policy?.mode === 'read-only') {
        throw new FsError(`${sandboxDenialMarker(policy.mode)}\napply_patch requires write access`, 'FS_SANDBOX_DENIED');
    }
    const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal });
    if (policy?.mode !== 'workspace-write')
        return target;
    for (const rootPath of writableRoots(policy)) {
        const root = await ctx.fs.resolve(rootPath, { signal: exec.signal });
        if (ctx.fs.contains(root, target))
            return target;
    }
    throw new FsError(`${sandboxDenialMarker(policy.mode)}\napply_patch cannot write ${target.displayPath}`, 'FS_SANDBOX_DENIED');
}
async function observeFinalState(ctx, files, cwd, exec) {
    const seen = new Set();
    for (const file of files) {
        for (const path of file.from === undefined ? [file.path] : [file.from, file.path]) {
            const key = path;
            if (seen.has(key))
                continue;
            seen.add(key);
            const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal });
            const info = await ctx.fs.stat(target, exec.signal);
            ctx.emit('fs/observed', target, info === undefined ? { kind: 'absent' } : { kind: 'present', version: info.version }, exec);
        }
    }
}
/** Execute one patch while leaving path and observation policy to the active DSH runtime. */
export async function runApplyPatch(ctx, patch, exec) {
    const sessionCwd = exec.agent?.session.header.cwd;
    if (sessionCwd === undefined || sessionCwd.trim().length === 0) {
        throw new PatchError('apply_patch: an agent session workspace is required', 'PATCH_UNSUPPORTED');
    }
    const policy = policyFor(ctx, exec);
    const cwdTarget = await ctx.fs.resolve('.', { cwd: sessionCwd, signal: exec.signal });
    const processCwd = ctx.fs.processPath(cwdTarget);
    const resolvePath = async (path) => {
        const target = await enforceSandbox(ctx, path, sessionCwd, exec, policy);
        return ctx.fs.processPath(target);
    };
    const result = await applyPatchAtomic({
        cwd: processCwd,
        patch,
        signal: exec.signal,
        resolvePath,
        async validatePath(path, expectedPath) {
            const currentPath = await resolvePath(path);
            if (currentPath !== expectedPath) {
                throw new PatchError(`apply_patch: path changed while patch was being prepared: ${path}`, 'PATCH_CONFLICT');
            }
        },
    });
    await observeFinalState(ctx, result.files, sessionCwd, exec).catch(() => undefined);
    return result;
}
