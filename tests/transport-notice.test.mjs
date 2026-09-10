import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resetFreeformTransportObservation } from '../lib/freeform-bridge.js'
import { apply, Config } from '../lib/index.js'
import {
  FALLBACK_TRANSPORT_NOTICE,
  FREEFORM_SETUP_URL,
  shouldShowFallbackNotice,
} from '../lib/transport-notice.js'

const NOTICE = /not on the recommended apply_patch configuration/u
const FALLBACK_PROVIDER = 'deepseek-official'
const FREEFORM_PROVIDER = 'deepseek-responses'

const base = {
  provider: FALLBACK_PROVIDER,
  freeformCapable: false,
  enabled: true,
  alreadyNotified: false,
}

test('notifies a session whose provider is not on the freeform route', () => {
  assert.equal(shouldShowFallbackNotice(base), true)
})

test('stays quiet once the same session has been told', () => {
  assert.equal(shouldShowFallbackNotice({ ...base, alreadyNotified: true }), false)
})

test('stays quiet on the recommended configuration', () => {
  assert.equal(shouldShowFallbackNotice({
    ...base,
    provider: FREEFORM_PROVIDER,
    freeformCapable: true,
  }), false)
})

test('treats an unknown provider as unconfirmed rather than recommended', () => {
  assert.equal(shouldShowFallbackNotice({ ...base, provider: undefined }), true)
  assert.equal(shouldShowFallbackNotice({ ...base, provider: undefined, freeformCapable: true }), true)
})

test('honours the configuration switch', () => {
  assert.equal(shouldShowFallbackNotice({ ...base, enabled: false }), false)
  assert.equal(shouldShowFallbackNotice({ ...base, enabled: false, provider: undefined }), false)
})

test('the notice points at the setup section and claims no measured benefit', () => {
  assert.ok(FALLBACK_TRANSPORT_NOTICE.includes(FREEFORM_SETUP_URL))
  assert.match(FALLBACK_TRANSPORT_NOTICE, NOTICE)
  assert.doesNotMatch(FALLBACK_TRANSPORT_NOTICE, /token|save|cheaper|faster|fewer/iu)
})

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-smarter-edit-notice-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function fsService(workspaceRoot) {
  return {
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
}

/** Register the plugin the way DSH does and hand back its apply_patch definition. */
async function plugin(t, config = {}) {
  const root = await workspace(t)
  let definition
  const ctx = {
    fs: fsService(root),
    get() {
      return undefined
    },
    emit() {},
    effect(setup) {
      const release = setup()
      if (typeof release === 'function') t.after(release)
      return () => {}
    },
    on() {},
    systemPrompt: { section() {} },
    tools: {
      register(value) {
        definition = value
      },
    },
  }
  await apply(ctx, { replaceNativeEdit: true, notifyFallbackTransport: true, ...config })
  assert.notEqual(definition, undefined)
  return { root, definition }
}

/** One agent session: `requestHeader()` is absent until the first request. */
function execution(cwd, provider) {
  return {
    signal: new AbortController().signal,
    agent: {
      session: {
        header: { cwd },
        requestHeader() {
          return provider === undefined ? undefined : { config: { provider, model: 'notice-test' } }
        },
      },
    },
  }
}

function addFile(name) {
  return `*** Begin Patch\n*** Add File: ${name}\n+${name}\n*** End Patch`
}

test('tells the first apply_patch result of a fallback session exactly once', async t => {
  const { root, definition } = await plugin(t)
  const exec = execution(root, FALLBACK_PROVIDER)

  const first = await definition.execute({ patch: addFile('first.txt') }, exec)
  const second = await definition.execute({ patch: addFile('second.txt') }, exec)

  assert.match(first.summary, NOTICE)
  assert.ok(first.summary.endsWith(FALLBACK_TRANSPORT_NOTICE))
  assert.match(first.diff, /first\.txt/u)
  assert.doesNotMatch(second.summary, /recommended configuration/u)
  assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first.txt\n')
  assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second.txt\n')
})

test('tells each fallback session independently', async t => {
  const { root, definition } = await plugin(t)

  const one = await definition.execute({ patch: addFile('one.txt') }, execution(root, FALLBACK_PROVIDER))
  const other = await definition.execute({ patch: addFile('other.txt') }, execution(root, FALLBACK_PROVIDER))

  assert.match(one.summary, NOTICE)
  assert.match(other.summary, NOTICE)
})

test('silences the notice without changing the result when the switch is off', async t => {
  const { root, definition } = await plugin(t, { notifyFallbackTransport: false })

  const result = await definition.execute({ patch: addFile('quiet.txt') }, execution(root, FALLBACK_PROVIDER))

  assert.doesNotMatch(result.summary, /recommended configuration/u)
  assert.match(result.summary, /Success\. Updated the following files:\nA quiet\.txt$/u)
  assert.equal(await readFile(join(root, 'quiet.txt'), 'utf8'), 'quiet.txt\n')
})

test('a session without a request header is not reported as the recommended setup', async t => {
  const { root, definition } = await plugin(t)

  const result = await definition.execute({ patch: addFile('unknown.txt') }, execution(root))

  assert.match(result.summary, NOTICE)
})

test('notifies by default when the profile leaves the switch unset', async t => {
  // DSH resolves plugin config through the exported schema before apply().
  const validated = Config['~standard'].validate({ replaceNativeEdit: true })
  assert.equal(validated.issues, undefined)
  assert.equal(validated.value.notifyFallbackTransport, true)

  const { root, definition } = await plugin(t, validated.value)
  const result = await definition.execute({ patch: addFile('default.txt') }, execution(root, FALLBACK_PROVIDER))

  assert.match(result.summary, NOTICE)
})

test('a session that cannot report its provider never fails an applied patch', async t => {
  const { root, definition } = await plugin(t)
  const throwing = execution(root, FALLBACK_PROVIDER)
  throwing.agent.session.requestHeader = () => {
    throw new Error('incompatible session surface')
  }
  const withoutMethod = execution(root, FALLBACK_PROVIDER)
  delete withoutMethod.agent.session.requestHeader

  const thrown = await definition.execute({ patch: addFile('thrown.txt') }, throwing)
  const absent = await definition.execute({ patch: addFile('absent.txt') }, withoutMethod)

  assert.match(thrown.summary, NOTICE)
  assert.match(absent.summary, NOTICE)
  assert.equal(await readFile(join(root, 'thrown.txt'), 'utf8'), 'thrown.txt\n')
  assert.equal(await readFile(join(root, 'absent.txt'), 'utf8'), 'absent.txt\n')
})

test('records the pi-ai boundary and stays quiet only for routes that reached it', async t => {
  const prototype = PiAiAdapter.prototype
  const streamDescriptor = Object.getOwnPropertyDescriptor(prototype, 'stream')
  const prepareDescriptor = Object.getOwnPropertyDescriptor(prototype, 'prepareCall')
  resetFreeformTransportObservation()
  Object.defineProperty(prototype, 'stream', {
    configurable: true,
    writable: true,
    value() {
      return (async function* empty() {})()
    },
  })
  if (prepareDescriptor !== undefined) {
    Object.defineProperty(prototype, 'prepareCall', {
      configurable: true,
      writable: true,
      async value() {
        return { model: {}, stream: () => (async function* empty() {})() }
      },
    })
  }
  try {
    const { root, definition } = await plugin(t)
    for await (const _event of prototype.stream.call({}, {
      provider: FREEFORM_PROVIDER,
      messages: [],
      tools: [],
    })) { /* drain */ }

    const recommended = await definition.execute({ patch: addFile('recommended.txt') }, execution(root, FREEFORM_PROVIDER))
    const fallback = await definition.execute({ patch: addFile('fallback.txt') }, execution(root, FALLBACK_PROVIDER))

    assert.doesNotMatch(recommended.summary, /recommended configuration/u)
    assert.match(fallback.summary, NOTICE)
  } finally {
    // releaseBridge() only restores the boundary it still owns, so restoring
    // the real descriptors first cannot be clobbered by the deferred release.
    if (streamDescriptor === undefined) delete prototype.stream
    else Object.defineProperty(prototype, 'stream', streamDescriptor)
    if (prepareDescriptor === undefined) delete prototype.prepareCall
    else Object.defineProperty(prototype, 'prepareCall', prepareDescriptor)
    resetFreeformTransportObservation()
  }
})
