import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

function element(type, props) {
  return { type, props: props ?? {} }
}

function findElement(root, type) {
  if (root === null || root === undefined || typeof root !== 'object') return null
  if (root.type === type) return root
  const children = root.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findElement(child, type)
    if (match !== null) return match
  }
  return null
}

function findClass(root, className) {
  if (root === null || root === undefined || typeof root !== 'object') return null
  if (root.props?.className === className) return root
  const children = root.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findClass(child, className)
    if (match !== null) return match
  }
  return null
}

test('uses only the Desktop alpha.1 primitive surface and registers its keyed toolview', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const primitiveMembers = [...source.matchAll(/dsh_client_ui_primitives_1\.([A-Za-z0-9_]+)/gu)]
    .map(match => match[1])
  assert.deepEqual([...new Set(primitiveMembers)].sort(), [
    'DiffBlock',
    'DisclosureRow',
    'IconEditOutline16',
    'IconInspectOutline12',
    'StateDot',
  ])
  let bundle
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) { bundle = value },
      },
    },
  }
  vm.runInNewContext(source, context)
  assert.equal(bundle.id, '@anionex/dsh-apply-patch')

  const DiffBlock = Symbol('DiffBlock')
  const DisclosureRow = Symbol('DisclosureRow')
  const modules = {
    'react/jsx-runtime': {
      Fragment: Symbol('Fragment'),
      jsx: element,
      jsxs: element,
    },
    react: {
      useMemo(factory) { return factory() },
      useState(initial) { return [initial, () => undefined] },
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
      DiffBlock,
      DisclosureRow,
      IconEditOutline16: Symbol('IconEditOutline16'),
      IconInspectOutline12: Symbol('IconInspectOutline12'),
      StateDot: Symbol('StateDot'),
    },
  }
  const client = bundle.factory(id => modules[id])
  let registration
  client.apply({
    effect() {},
    slots: {
      inject(name, setup) {
        assert.equal(name, 'tool.call.toolview')
        setup()
      },
      register(options, component) {
        registration = { options, component }
        return () => undefined
      },
    },
  })
  assert.deepEqual(
    { ...registration.options },
    { name: 'tool.call.toolview', key: 'apply_patch', locale: 'conversation' },
  )

  const diffs = [{
    path: 'src/app.ts',
    oldText: 'before\nold\nafter',
    newText: 'before\nnew\nafter',
  }]
  const baseProps = {
    callId: 'call-1',
    toolName: 'apply_patch',
    openFile() {},
    loadImage() {},
    t(key, params) { return `${key}:${params?.count ?? ''}` },
  }
  const successBlock = {
    kind: 'tool-result',
    callId: 'call-1',
    call: {
      name: 'apply_patch',
      argsRaw: '*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch',
    },
    content: [{
      type: 'text',
      text: `Success.

===================================================================
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 context
-old
+new
 context`,
    }],
    isError: false,
    meta: { diffs },
    subCalls: [],
  }
  const tree = registration.component({ ...baseProps, block: successBlock })
  const diff = findElement(tree, DiffBlock)
  assert.notEqual(diff, null)
  assert.equal(JSON.stringify(diff.props.diffs), JSON.stringify(diffs))
  assert.equal(diff.props.maxLines, 8)
  const disclosure = findElement(tree, DisclosureRow)
  assert.equal(disclosure.props.title, 'Apply patch')
  const collapsedChildren = disclosure.props.collapsedContent.props.children
  assert.equal(collapsedChildren[2].props.children.join(''), '+3 -3')

  const running = registration.component({
    ...baseProps,
    block: {
      callId: 'call-1',
      name: 'apply_patch',
      argsRaw: '*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch',
    },
  })
  assert.equal(running.props['data-state'], 'running')
  assert.equal(findElement(running, DisclosureRow).props.icon.props.state, 'ongoing')

  const failure = registration.component({
    ...baseProps,
    block: {
      ...successBlock,
      isError: true,
      error: { name: 'PatchError', code: 'failed' },
      meta: { diffs: 'invalid' },
    },
  })
  assert.equal(findElement(failure, DiffBlock), null)
  assert.equal(findClass(failure, 'dsh-apply-patch-row__output').props['data-error'], true)
  assert.equal(findElement(failure, DisclosureRow).props.icon.props.state, 'error')

  const stopped = registration.component({
    ...baseProps,
    block: {
      ...successBlock,
      isError: true,
      error: { name: 'AbortError', code: 'interrupted' },
      meta: undefined,
    },
  })
  assert.equal(stopped.props['data-state'], 'stopped')
  assert.equal(findElement(stopped, DisclosureRow).props.icon.props.state, 'warning')

  for (const meta of [undefined, { diffs: 'invalid' }]) {
    const historical = registration.component({
      ...baseProps,
      block: { ...successBlock, meta },
    })
    assert.equal(findElement(historical, DiffBlock), null)
    assert.equal(findClass(historical, 'dsh-apply-patch-row__output').props['data-error'], false)
  }
})
