import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyPatchAtomic } from '../lib/engine.js'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-apply-patch-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function text(path) {
  return readFile(path, 'utf8')
}

test('applies a multi-file transaction and returns an actual unified diff', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'app.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(root, 'delete.txt'), 'remove me\n')
  await writeFile(join(root, 'move.txt'), 'old\n')

  const result = await applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Update File: app.txt
@@
 one
-two
+TWO
 three
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`,
  })

  assert.equal(await text(join(root, 'app.txt')), 'one\nTWO\nthree\n')
  assert.equal(await text(join(root, 'nested/new.txt')), 'created\n')
  assert.equal(await text(join(root, 'moved.txt')), 'new\n')
  await assert.rejects(readFile(join(root, 'delete.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(root, 'move.txt')), { code: 'ENOENT' })
  assert.equal(result.summary, 'Success. Updated the following files:\nA nested/new.txt\nM app.txt\nM moved.txt\nD delete.txt')
  assert.match(result.diff, /--- a\/app\.txt/u)
  assert.match(result.diff, /\+TWO/u)
  assert.deepEqual(result.files.map(file => file.action), ['update', 'add', 'delete', 'move'])
  assert.deepEqual(result.diffs.map(diff => diff.path), [
    'app.txt',
    'delete.txt',
    'move.txt',
    'moved.txt',
    'nested/new.txt',
  ])
  assert.deepEqual(result.diffs[0], {
    path: 'app.txt',
    oldText: 'one\ntwo\nthree',
    newText: 'one\nTWO\nthree',
  })
  assert.deepEqual(Object.fromEntries(result.diffs.slice(1).map(diff => [diff.path, {
    oldText: diff.oldText,
    newText: diff.newText,
  }])), {
    'delete.txt': { oldText: 'remove me', newText: '' },
    'move.txt': { oldText: 'old', newText: '' },
    'moved.txt': { oldText: null, newText: 'new' },
    'nested/new.txt': { oldText: null, newText: 'created' },
  })
})

test('keeps distant updates as separate replayable presentation hunks', async t => {
  const root = await workspace(t)
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
  await writeFile(join(root, 'spread.txt'), `${lines.join('\n')}\n`)

  const result = await applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Update File: spread.txt
@@
-line 1
+first
@@
-line 12
+last
*** End Patch`,
  })

  assert.equal(result.diffs.length, 2)
  assert.deepEqual(result.diffs.map(diff => diff.path), ['spread.txt', 'spread.txt'])
  assert.match(result.diffs[0].newText, /^first\nline 2/u)
  assert.doesNotMatch(result.diffs[0].newText, /last/u)
  assert.match(result.diffs[1].newText, /line 11\nlast$/u)
})

test('preflight failure leaves every target untouched', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'app.txt'), 'original\n')
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Add File: created.txt
+should not exist
*** Update File: app.txt
@@
-missing
+replacement
*** End Patch`,
  }), /Failed to find expected lines/u)
  assert.equal(await text(join(root, 'app.txt')), 'original\n')
  await assert.rejects(readFile(join(root, 'created.txt')), { code: 'ENOENT' })
})

test('commit fault rolls back already-published files and removes transaction artifacts', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'a.txt'), 'A\n')
  await writeFile(join(root, 'b.txt'), 'B\n')

  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Update File: a.txt
@@
-A
+AA
*** Update File: b.txt
@@
-B
+BB
*** End Patch`,
    hooks: {
      beforeCommitPath(_path, index) {
        if (index === 1) throw new Error('injected commit fault')
      },
    },
  }), /rolled back/u)

  assert.equal(await text(join(root, 'a.txt')), 'A\n')
  assert.equal(await text(join(root, 'b.txt')), 'B\n')
  assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'b.txt'])
})

test('rollback removes files and directories created earlier in the transaction', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'z.txt'), 'Z\n')
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Add File: nested/new.txt
+new
*** Update File: z.txt
@@
-Z
+ZZ
*** End Patch`,
    hooks: {
      beforeCommitPath(_path, index) {
        if (index === 1) throw new Error('injected commit fault')
      },
    },
  }), /rolled back/u)
  assert.equal(await text(join(root, 'z.txt')), 'Z\n')
  await assert.rejects(readFile(join(root, 'nested/new.txt')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(root), ['z.txt'])
})

test('detects a concurrent change after staging without overwriting it', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'a.txt'), 'A\n')
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Update File: a.txt
@@
-A
+AA
*** End Patch`,
    hooks: {
      async beforeVerify() {
        await writeFile(join(root, 'a.txt'), 'external\n')
      },
    },
  }), /changed while patch was being prepared/u)
  assert.equal(await text(join(root, 'a.txt')), 'external\n')
  assert.deepEqual(await readdir(root), ['a.txt'])
})

test('captures and rejects a change made after the final pre-commit verification', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'a.txt'), 'A\n')
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Update File: a.txt
@@
-A
+AA
*** End Patch`,
    hooks: {
      async beforeCommitPath() {
        await writeFile(join(root, 'a.txt'), 'concurrent\n')
      },
    },
  }), /changed immediately before commit/u)
  assert.equal(await text(join(root, 'a.txt')), 'concurrent\n')
  assert.deepEqual(await readdir(root), ['a.txt'])
})

test('never clobbers a concurrently created target', async t => {
  const root = await workspace(t)
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Add File: new.txt
+patch
*** End Patch`,
    hooks: {
      async beforeCommitPath() {
        await writeFile(join(root, 'new.txt'), 'concurrent\n')
      },
    },
  }), /rolled back/u)
  assert.equal(await text(join(root, 'new.txt')), 'concurrent\n')
  assert.deepEqual(await readdir(root), ['new.txt'])
})

test('stage-open and diff failures occur before target mutation and clean artifacts', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'a.txt'), 'A\n')
  const patch = `*** Begin Patch
*** Add File: nested/new.txt
+new
*** Update File: a.txt
@@
-A
+AA
*** End Patch`
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch,
    hooks: { afterStageOpen() { throw new Error('stage fault') } },
  }), /rolled back/u)
  assert.equal(await text(join(root, 'a.txt')), 'A\n')
  assert.deepEqual(await readdir(root), ['a.txt'])

  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch,
    hooks: { beforeDiff() { throw new Error('diff fault') } },
  }), /diff fault/u)
  assert.equal(await text(join(root, 'a.txt')), 'A\n')
  assert.deepEqual(await readdir(root), ['a.txt'])
})

test('a swapped stage entry cannot chmod or modify its symlink target', async t => {
  const root = await workspace(t)
  const outsideRoot = await workspace(t)
  const outside = join(outsideRoot, 'outside.txt')
  await writeFile(join(root, 'a.txt'), 'A\n')
  await writeFile(outside, 'outside\n')
  await chmod(outside, 0o600)

  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Update File: a.txt
@@
-A
+AA
*** End Patch`,
    hooks: {
      async afterStageOpen() {
        const stage = (await readdir(root)).find(name => name.endsWith('.stage'))
        assert.ok(stage)
        const { unlink } = await import('node:fs/promises')
        await unlink(join(root, stage))
        await symlink(outside, join(root, stage))
      },
    },
  }), /symbolic links|verification failed/u)
  assert.equal(await text(join(root, 'a.txt')), 'A\n')
  assert.equal(await text(outside), 'outside\n')
  assert.equal((await stat(outside)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(root), ['a.txt'])
})

test('folds repeated paths in operation order and rolls back a file/child collision', async t => {
  const root = await workspace(t)
  const repeated = await applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Add File: same.txt
+first
*** Update File: same.txt
@@
-first
+second
*** End Patch`,
  })
  assert.equal(await text(join(root, 'same.txt')), 'second\n')
  assert.deepEqual(repeated.files.map(file => file.action), ['add', 'update'])
  await assert.rejects(applyPatchAtomic({
    cwd: root,
    patch: `*** Begin Patch
*** Add File: parent
+file
*** Add File: parent/child
+child
*** End Patch`,
  }), /EISDIR|not a directory/u)
  assert.deepEqual(await readdir(root), ['same.txt'])
  assert.equal(await text(join(root, 'same.txt')), 'second\n')
})

test('accepts absolute paths, traversal, symlinks, non-UTF-8 replacement, and more than 100 paths', async t => {
  const root = await workspace(t)
  const cwd = join(root, 'cwd')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(cwd)
  const outside = join(root, 'outside.txt')
  const absolute = join(root, 'absolute.txt')
  await writeFile(outside, 'outside\n')
  await writeFile(absolute, 'absolute\n')
  await symlink(outside, join(cwd, 'link.txt'))
  await writeFile(join(cwd, 'binary.txt'), Buffer.from([0xff, 0xfe, 0xfd]))

  await applyPatchAtomic({
    cwd,
    patch: `*** Begin Patch
*** Update File: ../outside.txt
@@
-outside
+traversal
*** Update File: ${absolute}
@@
-absolute
+absolute path
*** Add File: binary.txt
+text replacement
*** End Patch`,
  })

  assert.equal(await text(outside), 'traversal\n')
  assert.equal(await text(absolute), 'absolute path\n')
  assert.equal(await text(join(cwd, 'binary.txt')), 'text replacement\n')

  await applyPatchAtomic({
    cwd,
    patch: `*** Begin Patch
*** Update File: link.txt
@@
-traversal
+linked
*** End Patch`,
  })
  assert.equal(await text(join(cwd, 'link.txt')), 'linked\n')
  assert.equal(await text(outside), 'linked\n')

  const manyFiles = Array.from({ length: 101 }, (_, index) => `*** Add File: many/${index}.txt\n+${index}`).join('\n')
  const result = await applyPatchAtomic({
    cwd,
    patch: `*** Begin Patch\n${manyFiles}\n*** End Patch`,
  })
  assert.equal(result.files.length, 101)
})
