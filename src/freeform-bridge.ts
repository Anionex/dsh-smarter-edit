import { readFile } from 'node:fs/promises'
import { PatchError } from './errors.js'

export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

interface PiToolLike {
  name?: unknown
  parameters?: unknown
  constrainedSampling?: unknown
  [key: string]: unknown
}

interface PiContextLike {
  tools?: PiToolLike[]
  [key: string]: unknown
}

interface ModelsLike {
  streamSimple(model: unknown, context: PiContextLike, options: unknown): unknown
  [key: PropertyKey]: unknown
}

interface SnapshotLike {
  models: ModelsLike
  [key: string]: unknown
}

type CurrentSnapshot = () => SnapshotLike
type AdapterStream = (this: unknown, options: unknown) => AsyncIterable<unknown>
type PrepareCall = (this: unknown, ...args: unknown[]) => Promise<unknown>

interface BridgePrototype {
  current?: CurrentSnapshot
  prepareCall?: PrepareCall
  stream?: AdapterStream
}

interface GlobalBridgeState {
  prototype: BridgePrototype
  original: CurrentSnapshot
  wrapper: CurrentSnapshot
  originalPrepareCall?: PrepareCall
  prepareCallWrapper?: PrepareCall
  originalStream: AdapterStream
  streamWrapper: AdapterStream
  references: number
}

const STATE_KEY = Symbol.for('@anionex/dsh-apply-patch/pi-ai-freeform-bridge')
const globalBridge = globalThis as typeof globalThis & { [STATE_KEY]?: GlobalBridgeState }

function isPatchStringSchema(parameters: unknown): boolean {
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) return false
  const schema = parameters as { type?: unknown; required?: unknown; properties?: unknown }
  if (schema.type !== 'object' || !Array.isArray(schema.required) || !schema.required.includes('patch')) return false
  if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) return false
  const patch = (schema.properties as Record<string, unknown>).patch
  return typeof patch === 'object' && patch !== null && !Array.isArray(patch)
    && (patch as { type?: unknown }).type === 'string'
}

interface StreamChunkLike {
  type?: unknown
  index?: unknown
  name?: unknown
  argumentsDelta?: unknown
  block?: unknown
  [key: string]: unknown
}

interface PatchDeltaState {
  buffer: string
  mode: 'unknown' | 'json' | 'raw'
  closed: boolean
}

/** Recover one raw custom-tool input from pi-ai's required JSON execution envelope. */
export function unwrapApplyPatchArguments(serialized: string): string {
  if (serialized.startsWith('*** Begin Patch')) return serialized
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const [entry] = Object.entries(parsed as Record<string, unknown>)
      if (
        entry !== undefined
        && Object.keys(parsed).length === 1
        && (entry[0] === 'patch' || entry[0] === 'input')
        && typeof entry[1] === 'string'
      ) {
        return entry[1]
      }
    }
  } catch {
    // Fall through to the version-mismatch error below.
  }
  throw new PatchError(
    'dsh-apply-patch: pi-ai did not return the expected raw custom-tool input',
    'PATCH_UNSUPPORTED',
  )
}

/** Restore raw durable calls to pi-ai's internal grammar-tool envelope for replay. */
export function rewrapApplyPatchHistory(options: unknown): unknown {
  if (typeof options !== 'object' || options === null || !Array.isArray((options as { messages?: unknown }).messages)) {
    return options
  }
  let changed = false
  const messages = (options as { messages: unknown[] }).messages.map(message => {
    if (
      typeof message !== 'object'
      || message === null
      || (message as { role?: unknown }).role !== 'assistant'
      || !Array.isArray((message as { content?: unknown }).content)
    ) return message
    let contentChanged = false
    const content = (message as { content: unknown[] }).content.map(block => {
      if (
        typeof block !== 'object'
        || block === null
        || (block as { type?: unknown }).type !== 'tool-call'
        || (block as { name?: unknown }).name !== APPLY_PATCH_TOOL_NAME
        || typeof (block as { arguments?: unknown }).arguments !== 'string'
      ) return block
      const raw = (block as { arguments: string }).arguments
      if (!raw.trimStart().startsWith('*** Begin Patch')) return block
      contentChanged = true
      return { ...block, arguments: JSON.stringify({ patch: raw }) }
    })
    if (!contentChanged) return message
    changed = true
    return { ...message, content }
  })
  return changed ? { ...options, messages } : options
}

function decodeApplyPatchDelta(delta: string, state: PatchDeltaState): string {
  if (state.closed) {
    if (delta.trim().length === 0) return ''
    throw new PatchError('dsh-apply-patch: model emitted patch input after closing it', 'PATCH_UNSUPPORTED')
  }
  if (state.mode === 'raw') return delta
  state.buffer += delta
  if (state.mode === 'unknown') {
    const trimmed = state.buffer.trimStart()
    if (trimmed === '') return ''
    if (trimmed.startsWith('{')) {
      state.mode = 'json'
    } else if ('*** Begin Patch'.startsWith(trimmed)) {
      return ''
    } else if (trimmed.startsWith('*** Begin Patch')) {
      state.mode = 'raw'
      const raw = state.buffer
      state.buffer = ''
      return raw
    } else {
      throw new PatchError(
        'dsh-apply-patch: model changed its patch-tool streaming envelope',
        'PATCH_UNSUPPORTED',
      )
    }
  }
  try {
    const raw = unwrapApplyPatchArguments(state.buffer)
    state.buffer = ''
    state.closed = true
    return raw
  } catch {
    return ''
  }
}

function isApplyPatchEnd(chunk: StreamChunkLike): chunk is StreamChunkLike & {
  block: { type: 'tool-call'; name: string; arguments: string; [key: string]: unknown }
} {
  if (chunk.type !== 'block-end' || typeof chunk.block !== 'object' || chunk.block === null) return false
  const block = chunk.block as { type?: unknown; name?: unknown; arguments?: unknown }
  return block.type === 'tool-call'
    && block.name === APPLY_PATCH_TOOL_NAME
    && typeof block.arguments === 'string'
}

/**
 * Restore raw apply_patch input before DSH assembles or persists the ToolCallBlock.
 * Other chunks retain object identity; apply_patch deltas and final blocks are cloned.
 */
export async function* unwrapApplyPatchStream<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  const patchIndexes = new Map<unknown, PatchDeltaState>()
  for await (const value of source) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      yield value
      continue
    }
    const chunk = value as StreamChunkLike
    if (
      chunk.type === 'tool-call-delta'
      && (chunk.name === APPLY_PATCH_TOOL_NAME || patchIndexes.has(chunk.index))
    ) {
      if (typeof chunk.argumentsDelta !== 'string') {
        throw new PatchError('dsh-apply-patch: pi-ai emitted a non-string patch delta', 'PATCH_UNSUPPORTED')
      }
      const state = patchIndexes.get(chunk.index) ?? { buffer: '', mode: 'unknown', closed: false }
      patchIndexes.set(chunk.index, state)
      yield {
        ...chunk,
        argumentsDelta: decodeApplyPatchDelta(chunk.argumentsDelta, state),
      } as unknown as T
      continue
    }
    if (isApplyPatchEnd(chunk)) {
      patchIndexes.delete(chunk.index)
      yield {
        ...chunk,
        block: {
          ...chunk.block,
          arguments: unwrapApplyPatchArguments(chunk.block.arguments),
        },
      } as unknown as T
      continue
    }
    yield value
  }
}

/** Add pi-ai grammar metadata only to this plugin's single-string tool schema. */
export function withApplyPatchGrammar(context: PiContextLike, grammar: string): PiContextLike {
  const tools = context.tools
  if (!Array.isArray(tools)) return context
  let changed = false
  const bridgedTools = tools.map((tool) => {
    if (tool.name !== APPLY_PATCH_TOOL_NAME || !isPatchStringSchema(tool.parameters)) return tool
    changed = true
    return {
      ...tool,
      constrainedSampling: {
        type: 'grammar',
        variants: { openai_lark: grammar },
      },
    }
  })
  return changed ? { ...context, tools: bridgedTools } : context
}

function grammarCapableModel(model: unknown): unknown {
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
  const compat = typeof (model as { compat?: unknown }).compat === 'object'
    && (model as { compat?: unknown }).compat !== null
    && !Array.isArray((model as { compat?: unknown }).compat)
    ? (model as { compat: Record<string, unknown> }).compat
    : {}
  return {
    ...model,
    compat: {
      ...compat,
      supportsOpenAIGrammarTools: true,
    },
  }
}

/** Wrap one pi-ai snapshot without mutating its immutable Models collection. */
export function bridgeSnapshot(snapshot: SnapshotLike, grammar: string): SnapshotLike {
  const models = snapshot.models
  const bridgedModels = new Proxy(models, {
    get(target, property) {
      if (property === 'streamSimple') {
        return (model: unknown, context: PiContextLike, options: unknown): unknown => {
          const bridgedContext = withApplyPatchGrammar(context, grammar)
          const bridgedModel = bridgedContext === context ? model : grammarCapableModel(model)
          return target.streamSimple(bridgedModel, bridgedContext, options)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...snapshot, models: bridgedModels }
}

async function loadGrammar(): Promise<string> {
  const grammarUrl = new URL('../third_party/codex/apply_patch.lark', import.meta.url)
  const grammar = await readFile(grammarUrl, 'utf8')
  if (grammar.trim().length === 0) {
    throw new PatchError('dsh-apply-patch: bundled freeform grammar is empty', 'PATCH_UNSUPPORTED')
  }
  return grammar
}

/**
 * Upgrade pi-ai's apply_patch function schema to an OpenAI custom grammar tool.
 * DSH strips constrained-sampling metadata before pi-ai, so the bridge wraps
 * the adapter's request-frozen Models snapshot shared by alpha and rc builds.
 */
export async function installPiAiFreeformBridge(): Promise<() => void> {
  const grammar = await loadGrammar()
  const imported = await import('@deepseek-ai/dsh-llm-pi-ai')
  const prototype = imported.PiAiAdapter.prototype as unknown as BridgePrototype

  const existing = globalBridge[STATE_KEY]
  if (existing !== undefined) {
    if (existing.prototype !== prototype) {
      throw new PatchError('dsh-apply-patch: conflicting pi-ai adapter prototype is already bridged', 'PATCH_UNSUPPORTED')
    }
    existing.references += 1
    return () => releaseBridge(existing)
  }

  const original = prototype.current
  if (typeof original !== 'function') {
    throw new PatchError(
      'dsh-apply-patch: this dsh-llm-pi-ai version has no compatible current snapshot boundary',
      'PATCH_UNSUPPORTED',
    )
  }

  const bridgedSnapshots = new WeakMap<object, SnapshotLike>()
  const wrapper: CurrentSnapshot = function(this: unknown): SnapshotLike {
    const snapshot = original.call(this)
    if (typeof snapshot !== 'object' || snapshot === null || typeof snapshot.models !== 'object') {
      throw new PatchError('dsh-apply-patch: pi-ai adapter returned an incompatible snapshot', 'PATCH_UNSUPPORTED')
    }
    const cached = bridgedSnapshots.get(snapshot)
    if (cached !== undefined) return cached
    const bridged = bridgeSnapshot(snapshot, grammar)
    bridgedSnapshots.set(snapshot, bridged)
    return bridged
  }
  Object.defineProperty(prototype, 'current', {
    configurable: true,
    writable: true,
    value: wrapper,
  })
  const originalStream = prototype.stream
  if (typeof originalStream !== 'function') {
    Object.defineProperty(prototype, 'current', {
      configurable: true,
      writable: true,
      value: original,
    })
    throw new PatchError(
      'dsh-apply-patch: this dsh-llm-pi-ai version has no compatible stream boundary',
      'PATCH_UNSUPPORTED',
    )
  }
  const streamWrapper = function(this: unknown, options: unknown): AsyncIterable<unknown> {
    return originalStream.call(this, rewrapApplyPatchHistory(options))
  }
  Object.defineProperty(prototype, 'stream', {
    configurable: true,
    writable: true,
    value: streamWrapper,
  })
  let originalPrepareCall: PrepareCall | undefined
  let prepareCallWrapper: PrepareCall | undefined
  if (Object.hasOwn(prototype, 'prepareCall') && typeof prototype.prepareCall === 'function') {
    originalPrepareCall = prototype.prepareCall
    prepareCallWrapper = async function(this: unknown, ...args: unknown[]): Promise<unknown> {
      const prepared = await (originalPrepareCall as PrepareCall).apply(this, args)
      if (
        typeof prepared !== 'object'
        || prepared === null
        || typeof (prepared as { stream?: unknown }).stream !== 'function'
      ) {
        throw new PatchError(
          'dsh-apply-patch: pi-ai adapter returned an incompatible prepared call',
          'PATCH_UNSUPPORTED',
        )
      }
      const preparedStream = (prepared as { stream: (options: unknown) => unknown }).stream
      return {
        ...prepared,
        stream(options: unknown): unknown {
          return preparedStream(rewrapApplyPatchHistory(options))
        },
      }
    }
    Object.defineProperty(prototype, 'prepareCall', {
      configurable: true,
      writable: true,
      value: prepareCallWrapper,
    })
  }
  const state: GlobalBridgeState = {
    prototype,
    original,
    wrapper,
    ...(originalPrepareCall === undefined ? {} : {
      originalPrepareCall,
      prepareCallWrapper: prepareCallWrapper as PrepareCall,
    }),
    originalStream,
    streamWrapper,
    references: 1,
  }
  globalBridge[STATE_KEY] = state
  return () => releaseBridge(state)
}

function releaseBridge(state: GlobalBridgeState): void {
  if (globalBridge[STATE_KEY] !== state) return
  state.references -= 1
  if (state.references > 0) return
  if (state.prototype.current === state.wrapper) {
    Object.defineProperty(state.prototype, 'current', {
      configurable: true,
      writable: true,
      value: state.original,
    })
  }
  if (state.prototype.stream === state.streamWrapper) {
    Object.defineProperty(state.prototype, 'stream', {
      configurable: true,
      writable: true,
      value: state.originalStream,
    })
  }
  if (state.prototype.prepareCall === state.prepareCallWrapper && state.originalPrepareCall !== undefined) {
    Object.defineProperty(state.prototype, 'prepareCall', {
      configurable: true,
      writable: true,
      value: state.originalPrepareCall,
    })
  }
  delete globalBridge[STATE_KEY]
}
