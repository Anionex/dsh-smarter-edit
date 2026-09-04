import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { applyPatchAtomic } from '../lib/engine.js'

const scenariosRoot = new URL('./fixtures/codex-scenarios/', import.meta.url)
const rejectionScenarios = new Set([
  '005_rejects_empty_patch',
  '006_rejects_missing_context',
  '007_rejects_missing_file_delete',
  '008_rejects_empty_update_hunk',
  '009_requires_existing_file_for_update',
  '012_delete_directory_fails',
  '013_rejects_invalid_hunk_header',
  '015_failure_after_partial_success_leaves_changes',
])

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, await readFile(from))
    }
  }
}

async function snapshot(root) {
  const entries = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split('\\').join('/')
      if (entry.isDirectory()) {
        entries.push(['dir', name])
        await walk(path)
      } else if (entry.isFile()) {
        entries.push(['file', name, (await readFile(path)).toString('base64')])
      }
    }
  }
  if ((await stat(root).catch(() => undefined))?.isDirectory()) await walk(root)
  return entries.sort((left, right) => left[1].localeCompare(right[1]))
}

test('runs the official Codex scenario corpus with one documented atomicity override', async t => {
  const scenarios = (await readdir(scenariosRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  assert.equal(scenarios.length, 25, 'pinned Codex fixture count changed')
  assert.ok(scenarios.some(entry => entry.name === '001_add_file'))
  assert.ok(scenarios.some(entry => entry.name === '024_preserves_mixed_line_endings'))

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = join(scenariosRoot.pathname, scenario.name)
      const workspace = await mkdtemp(join(tmpdir(), 'dsh-smarter-edit-codex-'))
      try {
        const input = join(fixture, 'input')
        if ((await stat(input).catch(() => undefined))?.isDirectory()) await copyTree(input, workspace)
        const before = await snapshot(workspace)
        const patch = await readFile(join(fixture, 'patch.txt'), 'utf8')
        let failure
        try {
          await applyPatchAtomic({ cwd: workspace, patch })
        } catch (error) {
          failure = error
        }
        if (rejectionScenarios.has(scenario.name)) assert.ok(failure instanceof Error, 'scenario should reject')
        else assert.equal(failure, undefined, `scenario unexpectedly rejected: ${failure}`)

        if (scenario.name === '015_failure_after_partial_success_leaves_changes') {
          assert.deepEqual(
            await snapshot(workspace),
            before,
            'DSH intentionally wraps Codex derivation in all-file preflight and rollback',
          )
        } else {
          assert.deepEqual(await snapshot(workspace), await snapshot(join(fixture, 'expected')))
        }
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  }
})
