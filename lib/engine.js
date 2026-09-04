import { constants } from 'node:fs';
import { link, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import { PatchError, patchErrorMessage } from './errors.js';
import { applyChunks } from './matcher.js';
import { parsePatch } from './parser.js';
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new PatchError('apply_patch: operation aborted', 'PATCH_ABORTED', { cause: signal.reason });
    }
}
async function resolveTarget(cwd, input) {
    const requested = resolve(cwd, input);
    const suffix = [];
    let candidate = requested;
    while (true) {
        try {
            return {
                relativePath: input,
                absolutePath: resolve(await realpath(candidate), ...suffix),
            };
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            const parent = dirname(candidate);
            if (parent === candidate) {
                return { relativePath: input, absolutePath: requested };
            }
            suffix.unshift(basename(candidate));
            candidate = parent;
        }
    }
}
function fingerprint(info) {
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(':');
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
async function readSnapshot(absolutePath, signal) {
    throwIfAborted(signal);
    let info;
    try {
        info = await stat(absolutePath);
    }
    catch (error) {
        if (isMissing(error))
            return { exists: false };
        throw new PatchError(`apply_patch: cannot inspect ${absolutePath}: ${patchErrorMessage(error)}`, 'PATCH_IO', { cause: error });
    }
    let content;
    try {
        content = await readFile(absolutePath, 'utf8');
    }
    catch (error) {
        throw new PatchError(`apply_patch: cannot read ${absolutePath}: ${patchErrorMessage(error)}`, 'PATCH_IO', { cause: error });
    }
    throwIfAborted(signal);
    return {
        exists: true,
        content,
        mode: info.mode & 0o777,
        device: info.dev,
        inode: info.ino,
        fingerprint: fingerprint(info),
    };
}
function sameSnapshot(left, right) {
    return left.exists === right.exists
        && left.content === right.content
        && left.fingerprint === right.fingerprint;
}
function operationPaths(operation) {
    return operation.kind === 'update' && operation.moveTo !== undefined
        ? [operation.path, operation.moveTo]
        : [operation.path];
}
/** Return every source or destination path a parsed patch intends to mutate. */
export function mutationPaths(parsed) {
    return parsed.operations.flatMap(operationPaths);
}
async function buildPlan(options) {
    const parsed = parsePatch(options.patch);
    const cwd = resolve(options.cwd);
    const targets = new Map();
    const files = [];
    const targetFor = async (rawPath) => {
        const resolvedPath = options.resolvePath === undefined
            ? await resolveTarget(cwd, rawPath)
            : {
                relativePath: rawPath,
                absolutePath: resolve(await options.resolvePath(rawPath)),
            };
        const existing = targets.get(resolvedPath.absolutePath);
        if (existing !== undefined)
            return existing;
        const snapshot = await readSnapshot(resolvedPath.absolutePath, options.signal);
        const target = {
            ...resolvedPath,
            rawPath,
            snapshot,
            newContent: snapshot.content ?? null,
            published: false,
            backedUp: false,
        };
        targets.set(resolvedPath.absolutePath, target);
        return target;
    };
    for (const operation of parsed.operations) {
        throwIfAborted(options.signal);
        if (operation.kind === 'add') {
            const target = await targetFor(operation.path);
            target.newContent = operation.content;
            files.push({ action: 'add', path: target.relativePath });
            continue;
        }
        if (operation.kind === 'delete') {
            const target = await targetFor(operation.path);
            if (target.newContent === null) {
                throw new PatchError(`apply_patch: cannot delete missing file ${target.relativePath}`, 'PATCH_PATH_INVALID');
            }
            target.newContent = null;
            files.push({ action: 'delete', path: target.relativePath });
            continue;
        }
        const source = await targetFor(operation.path);
        if (source.newContent === null) {
            throw new PatchError(`apply_patch: cannot update missing file ${source.relativePath}`, 'PATCH_PATH_INVALID');
        }
        const updated = applyChunks(source.newContent, source.relativePath, operation.chunks);
        if (operation.moveTo === undefined) {
            source.newContent = updated;
            files.push({ action: 'update', path: source.relativePath });
            continue;
        }
        const destination = await targetFor(operation.moveTo);
        destination.newContent = updated;
        source.newContent = null;
        files.push({ action: 'move', path: destination.relativePath, from: source.relativePath });
    }
    const plannedTargets = [...targets.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (plannedTargets.length === 0) {
        throw new PatchError('apply_patch: No files were modified.', 'PATCH_CONFLICT');
    }
    return { targets: plannedTargets, files };
}
async function validateTargets(plan, options) {
    if (options.validatePath === undefined)
        return;
    for (const target of plan.targets) {
        await options.validatePath(target.rawPath, target.absolutePath);
    }
}
async function createMissingParents(directory, created) {
    const missing = [];
    let current = directory;
    while (true) {
        try {
            await stat(current);
            break;
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            missing.push(current);
            const parent = dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    for (const path of missing.reverse()) {
        await mkdir(path, { mode: 0o700 });
        created.push(path);
    }
}
async function stageTargets(plan, createdDirectories, options) {
    const transactionId = randomUUID();
    for (const [index, target] of plan.targets.entries()) {
        if (target.newContent === null)
            continue;
        throwIfAborted(options.signal);
        await createMissingParents(dirname(target.absolutePath), createdDirectories);
        const stagePath = resolve(dirname(target.absolutePath), `.${basename(target.absolutePath)}.${transactionId}.${index}.stage`);
        const handle = await open(stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        target.stagePath = stagePath;
        try {
            await options.hooks?.afterStageOpen?.(target.relativePath, index);
            await handle.writeFile(target.newContent, 'utf8');
            await handle.chmod(target.snapshot.mode ?? 0o644);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
}
async function verifyOriginals(plan, signal) {
    for (const target of plan.targets) {
        const current = await readSnapshot(target.absolutePath, signal);
        if (!sameSnapshot(current, target.snapshot)) {
            throw new PatchError(`apply_patch: file changed while patch was being prepared: ${target.relativePath}`, 'PATCH_CONFLICT');
        }
    }
}
async function verifyCapturedBackup(target, signal) {
    const captured = await readSnapshot(target.backupPath, signal);
    const expected = target.snapshot;
    if (!captured.exists
        || captured.content !== expected.content
        || captured.mode !== expected.mode
        || captured.device !== expected.device
        || captured.inode !== expected.inode) {
        throw new PatchError(`apply_patch: file changed immediately before commit: ${target.relativePath}`, 'PATCH_CONFLICT');
    }
}
async function verifyFinals(plan, signal) {
    for (const target of plan.targets) {
        const current = await readSnapshot(target.absolutePath, signal);
        if (target.newContent === null) {
            if (current.exists)
                throw new PatchError(`apply_patch: deletion verification failed: ${target.relativePath}`, 'PATCH_IO');
        }
        else if (!current.exists || current.content !== target.newContent) {
            throw new PatchError(`apply_patch: write verification failed: ${target.relativePath}`, 'PATCH_IO');
        }
    }
}
async function removeIfPresent(path) {
    if (path === undefined)
        return;
    await rm(path, { force: true });
}
async function removeCreatedDirectories(paths) {
    for (const path of [...paths].reverse()) {
        try {
            await rmdir(path);
        }
        catch (error) {
            if (!isMissing(error) && error.code !== 'ENOTEMPTY')
                throw error;
        }
    }
}
async function rollback(plan, createdDirectories) {
    const failures = [];
    for (const target of [...plan.targets].reverse()) {
        try {
            if (target.published) {
                await removeIfPresent(target.absolutePath);
                target.published = false;
            }
            if (target.backedUp && target.backupPath !== undefined) {
                await link(target.backupPath, target.absolutePath);
                await unlink(target.backupPath);
                delete target.backupPath;
                target.backedUp = false;
            }
        }
        catch (error) {
            failures.push(`${target.relativePath}: ${patchErrorMessage(error)}`);
        }
    }
    for (const target of plan.targets) {
        try {
            await removeIfPresent(target.stagePath);
            if (!target.backedUp)
                await removeIfPresent(target.backupPath);
        }
        catch (error) {
            failures.push(`cleanup ${target.relativePath}: ${patchErrorMessage(error)}`);
        }
    }
    try {
        await removeCreatedDirectories(createdDirectories);
    }
    catch (error) {
        failures.push(`directory cleanup: ${patchErrorMessage(error)}`);
    }
    if (failures.length > 0) {
        throw new PatchError(`apply_patch: rollback failed: ${failures.join('; ')}`, 'PATCH_ROLLBACK_FAILED');
    }
}
async function commit(plan, options) {
    const createdDirectories = [];
    let committed = false;
    try {
        await verifyOriginals(plan, options.signal);
        await validateTargets(plan, options);
        await stageTargets(plan, createdDirectories, options);
        await options.hooks?.beforeVerify?.();
        await verifyOriginals(plan, options.signal);
        const transactionId = randomUUID();
        for (const [index, target] of plan.targets.entries()) {
            throwIfAborted(options.signal);
            await options.hooks?.beforeCommitPath?.(target.relativePath, index);
            await options.validatePath?.(target.rawPath, target.absolutePath);
            if (target.snapshot.exists) {
                target.backupPath = resolve(dirname(target.absolutePath), `.${basename(target.absolutePath)}.${transactionId}.${index}.backup`);
                await rename(target.absolutePath, target.backupPath);
                target.backedUp = true;
                await verifyCapturedBackup(target, options.signal);
            }
            if (target.newContent !== null) {
                await link(target.stagePath, target.absolutePath);
                target.published = true;
                await unlink(target.stagePath);
                delete target.stagePath;
            }
        }
        await verifyFinals(plan, options.signal);
        committed = true;
    }
    catch (error) {
        try {
            await rollback(plan, createdDirectories);
        }
        catch (rollbackError) {
            throw new PatchError(`apply_patch: transaction failed (${patchErrorMessage(error)}); ${patchErrorMessage(rollbackError)}`, 'PATCH_ROLLBACK_FAILED', { cause: error });
        }
        if (error instanceof PatchError)
            throw error;
        throw new PatchError(`apply_patch: transaction failed and was rolled back: ${patchErrorMessage(error)}`, 'PATCH_IO', { cause: error });
    }
    finally {
        for (const target of plan.targets) {
            await removeIfPresent(target.stagePath).catch(() => undefined);
        }
    }
    if (committed) {
        // The target state is already verified. A backup cleanup failure must leave
        // that recovery copy in place, not trigger an irreversible late rollback.
        for (const target of plan.targets) {
            try {
                await removeIfPresent(target.backupPath);
                delete target.backupPath;
                target.backedUp = false;
            }
            catch {
                // Preserve the backup for manual recovery; target files remain correct.
            }
        }
    }
}
function canonicalDiff(plan) {
    return plan.targets.map(target => {
        const oldName = target.snapshot.exists ? `a/${target.relativePath}` : '/dev/null';
        const newName = target.newContent === null ? '/dev/null' : `b/${target.relativePath}`;
        return createTwoFilesPatch(oldName, newName, target.snapshot.content ?? '', target.newContent ?? '', '', '', { context: 3 }).trimEnd();
    }).filter(Boolean).join('\n');
}
/** Derive the same three-line-context hunks consumed by DSH's native DiffBlock. */
function presentationDiffs(plan) {
    return plan.targets.flatMap((target) => {
        const patch = structuredPatch('', '', target.snapshot.content ?? '', target.newContent ?? '', undefined, undefined, { context: 3 });
        return patch.hunks.map((hunk) => {
            const oldLines = [];
            const newLines = [];
            for (const line of hunk.lines) {
                if (line.startsWith('\\'))
                    continue;
                const text = line.slice(1);
                if (line.startsWith('-'))
                    oldLines.push(text);
                else if (line.startsWith('+'))
                    newLines.push(text);
                else {
                    oldLines.push(text);
                    newLines.push(text);
                }
            }
            return {
                path: target.relativePath,
                oldText: oldLines.length === 0 ? null : oldLines.join('\n'),
                newText: newLines.join('\n'),
            };
        });
    });
}
function codexSummary(files) {
    const lines = ['Success. Updated the following files:'];
    for (const file of files.filter(candidate => candidate.action === 'add'))
        lines.push(`A ${file.path}`);
    for (const file of files.filter(candidate => candidate.action === 'update' || candidate.action === 'move'))
        lines.push(`M ${file.path}`);
    for (const file of files.filter(candidate => candidate.action === 'delete'))
        lines.push(`D ${file.path}`);
    return lines.join('\n');
}
/** Parse, preflight, stage, atomically publish, verify, and summarize one patch. */
export async function applyPatchAtomic(options) {
    const plan = await buildPlan(options);
    await options.hooks?.beforeDiff?.();
    const diff = canonicalDiff(plan);
    const diffs = presentationDiffs(plan);
    await commit(plan, options);
    return {
        summary: codexSummary(plan.files),
        diff,
        files: plan.files,
        diffs,
    };
}
export { parsePatch } from './parser.js';
export { applyChunks, seekSequence } from './matcher.js';
export { PatchError } from './errors.js';
