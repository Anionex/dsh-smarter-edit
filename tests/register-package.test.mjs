import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { apply, applyPatchText, inject, name } from '../lib/index.js'

test('registers one raw patch string tool and filters native mutation tools', async () => {
  let definition
  let middleware
  let llmMiddleware
  const sections = []
  const disposers = []
  const ctx = {
    fs: { sandboxMode: undefined },
    tools: { register(value) { definition = value; return () => undefined } },
    systemPrompt: { section(value) { sections.push(value); return () => undefined } },
    effect(setup) { disposers.push(setup()) },
    on(event, listener) {
      if (event === 'system-prompt/assemble') middleware = listener
      if (event === 'llm/stream') llmMiddleware = listener
      return () => undefined
    },
  }

  await apply(ctx, {
    replaceNativeEdit: true,
  })
  try {
    assert.equal(name, '@anionex/dsh-apply-patch')
    assert.deepEqual(inject, ['tools', 'fs', 'llm', 'systemPrompt'])
    assert.equal(definition.name, 'apply_patch')
    assert.deepEqual(definition.parameters.required, ['patch'])
    assert.equal(definition.parameters.properties.patch.type, 'string')
    assert.equal(definition.description, 'Create, update, move, and delete files by applying a patch.')
    assert.equal(sections[0].name, 'tool:apply-patch')
    const raw = '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n'
    assert.equal(applyPatchText(raw), raw)
    assert.equal(applyPatchText({ patch: raw }), raw)
    assert.deepEqual(definition.presentCall(raw).locations, [{ path: 'a.txt' }])
    await assert.rejects(
      definition.execute({}, {}),
      /arguments must be raw apply_patch text/u,
    )
    const serialized = JSON.stringify({ patch: raw })
    async function* stream() {
      for (const [index, character] of [...serialized].entries()) {
        yield {
          type: 'tool-call-delta',
          index: 0,
          ...(index === 0 ? { name: 'apply_patch' } : {}),
          argumentsDelta: character,
        }
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-1', name: 'apply_patch', arguments: serialized },
      }
    }
    const chunks = []
    for await (const chunk of llmMiddleware({}, stream)) chunks.push(chunk)
    assert.equal(chunks.filter(chunk => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.argumentsDelta).join(''), raw)
    assert.equal(chunks.at(-1).block.arguments, raw)

    const assembled = await middleware({}, {}, async () => ({
      tools: [
        { name: 'edit' },
        { name: 'write' },
        { name: 'str_replace_editor' },
        { name: 'apply_patch' },
      ],
      sections: [
        { name: 'tool:edit', text: 'native edit' },
        { name: 'tool:write', text: 'Use write and prefer edit for targeted changes.' },
        { name: 'tool:apply-patch', text: 'apply patch' },
      ],
      contexts: [],
      variables: {},
    }))
    assert.deepEqual(assembled.tools.map(tool => tool.name), ['apply_patch'])
    assert.deepEqual(assembled.sections.map(section => section.name), ['tool:apply-patch'])
    assert.equal(definition.description, 'Create, update, move, and delete files by applying a patch.')
    assert.doesNotMatch(definition.description, /Codex|custom|freeform|preflight|rollback|transport/iu)
    assert.doesNotMatch(assembled.sections[0].text, /Codex|custom|freeform|preflight|rollback|transport/iu)
    assert.equal(
      definition.parameters.properties.patch.description,
      'Patch text containing one or more file operations.',
    )
    const value = {
      summary: 'Done!',
      diff: '--- a\n+++ b',
      files: [],
      diffs: [{ path: 'a.txt', oldText: 'old', newText: 'new' }],
    }
    assert.match(definition.output.render({}, value)[0].text, /--- a/u)
    assert.deepEqual(definition.output.presentationMeta({}, value), { diffs: value.diffs })
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})

test('keeps native mutation tools when replacement is disabled', async () => {
  let middleware
  const disposers = []
  const ctx = {
    fs: { sandboxMode: undefined },
    tools: { register() { return () => undefined } },
    systemPrompt: { section() { return () => undefined } },
    effect(setup) { disposers.push(setup()) },
    on(event, listener) {
      if (event === 'system-prompt/assemble') middleware = listener
      return () => undefined
    },
  }

  await apply(ctx, { replaceNativeEdit: false })
  try {
    assert.equal(middleware, undefined)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})

test('package is a portable prebuilt DSH Profile Bundle', async () => {
  const root = new URL('../', import.meta.url)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')
  assert.equal(pkg.name, '@anionex/dsh-apply-patch')
  assert.equal(pkg.version, '0.1.4')
  assert.equal(pkg.description, 'A better approach to editing files in DSH.')
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.publishConfig.access, 'public')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'))
  assert.ok(pkg.dsh.compatibility.profiles.includes('desktop'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/types/index.d.ts')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('src'))
  assert.ok(pkg.files.includes('third_party'))
  assert.ok(pkg.files.includes('assets'))
  assert.ok(pkg.files.includes('CHANGELOG.md'))
  assert.ok(pkg.files.includes('SECURITY.md'))
  assert.equal(typeof pkg.scripts.build, 'string')
  assert.equal(typeof pkg.scripts.prepack, 'string')
  assert.match(workspace, /^packages:\n  - \.$/mu)
  assert.match(workspace, /^nodeLinker: hoisted$/mu)
  assert.match(workspace, /^autoInstallPeers: false$/mu)
  await access(new URL(pkg.main, root))
  await access(new URL(pkg.types, root))
  await access(new URL(pkg.exports['./client'].default, root))
  await access(new URL(pkg.exports['./client'].types, root))
  await access(new URL(pkg.dsh.bundle.patch, root))
  await access(new URL('third_party/codex/apply_patch.lark', root))
  await access(new URL('third_party/codex/LICENSE', root))
  await access(new URL('third_party/codex/NOTICE', root))

  for (const [dependency, specifier] of Object.entries(pkg.devDependencies ?? {})) {
    assert.equal(
      isAbsolute(specifier) || /^(?:file|link):/u.test(specifier) || /^[A-Za-z]:[\\/]/u.test(specifier),
      false,
      `devDependency ${dependency} must not be machine-local`,
    )
  }
})
