import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { runApplyPatch } from '../lib/host.js'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-smarter-edit-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function context(workspaceRoot, mode) {
  const fs = {
    sandboxMode: mode,
    async resolve(path, options = {}) {
      const absolute = isAbsolute(path) ? resolve(path) : resolve(options.cwd ?? workspaceRoot, path)
      let targetKey
      try {
        targetKey = await realpath(absolute)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        targetKey = join(await realpath(resolve(absolute, '..')), absolute.split('/').at(-1))
      }
      return { targetKey, displayPath: absolute }
    },
    processPath(target) {
      return target.targetKey
    },
    contains(parent, child) {
      const path = relative(parent.targetKey, child.targetKey)
      return path === '' || (!path.startsWith('..') && !isAbsolute(path))
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey)
        return { type: info.isDirectory() ? 'directory' : 'file', version: String(info.mtimeNs) }
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    },
  }
  return {
    fs,
    get(name) {
      if (name !== 'sandboxPolicy' || mode === undefined) return undefined
      return { resolve: () => ({ mode, workspaceRoot }) }
    },
    emit() {},
    waterfall() {
      throw new Error('apply_patch must not require a prior fs observation')
    },
  }
}

function execution(cwd) {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  }
}

test('runs without prior read guards or a host-identity proof', async t => {
  const root = await workspace(t)
  const ctx = context(root)
  await runApplyPatch(
    ctx,
    '*** Begin Patch\n*** Add File: direct.txt\n+direct\n*** End Patch',
    execution(root),
  )
  assert.equal(await readFile(join(root, 'direct.txt'), 'utf8'), 'direct\n')
})

test('uses DSH workspace-write roots, including the platform temp directory', async t => {
  const root = await workspace(t)
  const outside = await workspace(t)
  const destination = join(outside, 'outside.txt')
  const patch = `*** Begin Patch\n*** Add File: ${destination}\n+outside\n*** End Patch`

  await runApplyPatch(context(root, 'danger-full-access'), patch, execution(root))
  assert.equal(await readFile(destination, 'utf8'), 'outside\n')

  await rm(destination)
  await runApplyPatch(context(root, 'workspace-write'), patch, execution(root))
  assert.equal(await readFile(destination, 'utf8'), 'outside\n')

  const denied = `/opt/dsh-smarter-edit-${randomUUID()}.txt`
  await assert.rejects(
    runApplyPatch(
      context(root, 'workspace-write'),
      `*** Begin Patch\n*** Add File: ${denied}\n+denied\n*** End Patch`,
      execution(root),
    ),
    /sandbox denied|cannot write/iu,
  )
})

test('rechecks DSH path identity before staging and commit', async t => {
  const base = await mkdtemp(join(homedir(), '.dsh-smarter-edit-race-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const ctx = context(root, 'workspace-write')
  const ordinaryResolve = ctx.fs.resolve
  let targetResolutions = 0
  ctx.fs.resolve = async (path, options = {}) => {
    if (path !== 'link/escape.txt') return ordinaryResolve(path, options)
    targetResolutions += 1
    const absolute = targetResolutions % 2 === 1
      ? join(root, 'inside', 'escape.txt')
      : join(outside, 'escape.txt')
    return { targetKey: absolute, displayPath: absolute }
  }

  await assert.rejects(
    runApplyPatch(
      ctx,
      '*** Begin Patch\n*** Add File: link/escape.txt\n+escape\n*** End Patch',
      execution(root),
    ),
    /sandbox.*denied|path changed/isu,
  )
  await assert.rejects(readFile(join(outside, 'escape.txt')), error => error.code === 'ENOENT')
})

test('revalidates a POSIX filename containing a backslash without changing its identity', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await workspace(t)
  const result = await runApplyPatch(
    context(root, 'danger-full-access'),
    '*** Begin Patch\n*** Add File: back\\slash.txt\n+backslash\n*** End Patch',
    execution(root),
  )
  assert.equal(await readFile(join(root, 'back\\slash.txt'), 'utf8'), 'backslash\n')
  assert.equal(result.files[0].path, 'back\\slash.txt')
  assert.match(result.diff, /back\\slash\.txt/u)
})

test('does not turn a post-commit observation failure into a failed tool call', async t => {
  const root = await workspace(t)
  const ctx = context(root)
  ctx.fs.stat = async () => {
    throw new Error('injected observation failure')
  }
  const result = await runApplyPatch(
    ctx,
    '*** Begin Patch\n*** Add File: committed.txt\n+committed\n*** End Patch',
    execution(root),
  )
  assert.equal(result.files.length, 1)
  assert.equal(await readFile(join(root, 'committed.txt'), 'utf8'), 'committed\n')
})
