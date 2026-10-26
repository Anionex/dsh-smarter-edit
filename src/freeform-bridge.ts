import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
  messages?: { role?: string; toolsAdded?: PiToolLike[]; [key: string]: unknown }[]
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

const STATE_KEY = Symbol.for('@anionex/dsh-smarter-edit/pi-ai-freeform-bridge')
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
  id?: unknown
  name?: unknown
  argumentsDelta?: unknown
  block?: unknown
  [key: string]: unknown
}

interface PatchDeltaState {
  buffer: string
  emitted: string
  id: string
  mode: 'unknown' | 'json' | 'raw'
  closed: boolean
  rejected: boolean
  sawArgumentBytes: boolean
}

const KNOWN_PATCH_ARGUMENT_NAMES = new Set(['patch', 'input', 'arguments'])
export const REJECTED_APPLY_PATCH_ARGUMENTS = [
  '*** Begin Patch',
  '*** Invalid Tool Input: retry apply_patch with raw patch text, without JSON or a patch field',
  '*** End Patch',
].join('\n')

function syntheticToolCallId(): string {
  return `call_dsh_${randomUUID().replaceAll('-', '')}`
}

function describePatchString(value: string): string {
  const trimmed = value.trimStart()
  if (trimmed.startsWith('*** Begin Patch')) return 'string(raw patch)'
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return `string containing JSON array with ${parsed.length} item(s)`
    if (typeof parsed !== 'object' || parsed === null) {
      return `string containing JSON ${parsed === null ? 'null' : typeof parsed}`
    }
    const entries = Object.entries(parsed)
    const fields = entries.slice(0, 4).map(([key, nestedValue]) => {
      const displayedKey = KNOWN_PATCH_ARGUMENT_NAMES.has(key) ? JSON.stringify(key) : '"<unknown>"'
      const valueType = typeof nestedValue === 'string'
        && nestedValue.trimStart().startsWith('*** Begin Patch')
        ? 'string(raw patch)'
        : Array.isArray(nestedValue)
          ? 'array'
          : nestedValue === null
            ? 'null'
            : typeof nestedValue
      return `${displayedKey}:${valueType}`
    })
    return `string containing JSON object with ${entries.length} field(s)${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`
  } catch {
    const markerOffset = value.indexOf('*** Begin Patch')
    return markerOffset >= 0
      ? `string(patch marker at offset ${markerOffset})`
      : `string(${value.length} chars)`
  }
}

function describePatchArguments(serialized: string): string {
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (Array.isArray(parsed)) return `JSON array with ${parsed.length} item(s)`
    if (typeof parsed !== 'object' || parsed === null) return `JSON ${parsed === null ? 'null' : typeof parsed}`
    const entries = Object.entries(parsed)
    const fields = entries.slice(0, 4).map(([key, value]) => {
      const valueType = typeof value === 'string' && KNOWN_PATCH_ARGUMENT_NAMES.has(key)
        ? describePatchString(value)
        : Array.isArray(value)
          ? 'array'
          : value === null
            ? 'null'
            : typeof value
      const displayedKey = KNOWN_PATCH_ARGUMENT_NAMES.has(key) ? JSON.stringify(key) : '"<unknown>"'
      return `${displayedKey}:${valueType}`
    })
    return `JSON object with ${entries.length} field(s)${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`
  } catch {
    return `non-JSON text (${serialized.length} chars)`
  }
}

function countTopLevelJsonMembers(serialized: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  let memberCount = 0
  for (const character of serialized) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    else if (character === ':' && depth === 1) memberCount += 1
  }
  return memberCount
}

function tryUnwrapApplyPatchArguments(serialized: string): string | undefined {
  if (serialized.trimStart().startsWith('*** Begin Patch')) return serialized
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (
    entries.length === 0
    || countTopLevelJsonMembers(serialized) !== entries.length
    || entries.some(([key, value]) => !KNOWN_PATCH_ARGUMENT_NAMES.has(key) || typeof value !== 'string')
  ) {
    return undefined
  }

  const candidates: string[] = []
  for (const [, value] of entries as Array<[string, string]>) {
    if (value.trimStart().startsWith('*** Begin Patch')) {
      candidates.push(value)
      continue
    }
    const nested = tryUnwrapApplyPatchArguments(value)
    if (nested === undefined || !nested.trimStart().startsWith('*** Begin Patch')) return undefined
    candidates.push(nested)
  }

  const [candidate] = candidates
  if (
    candidate === undefined
    || candidates.some(value => value !== candidate)
  ) {
    return undefined
  }
  return candidate
}

/** Recover raw custom-tool input from pi-ai and provider fallback envelopes. */
export function unwrapApplyPatchArguments(serialized: string): string {
  const patch = tryUnwrapApplyPatchArguments(serialized)
  if (patch !== undefined) return patch
  throw new PatchError(
    `dsh-smarter-edit: pi-ai did not return the expected raw custom-tool input; received ${describePatchArguments(serialized)}`,
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
    throw new PatchError('dsh-smarter-edit: model emitted patch input after closing it', 'PATCH_UNSUPPORTED')
  }
  if (state.mode === 'raw') {
    state.emitted += delta
    return delta
  }
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
      state.emitted += raw
      return raw
    } else {
      throw new PatchError(
        'dsh-smarter-edit: model changed its patch-tool streaming envelope',
        'PATCH_UNSUPPORTED',
      )
    }
  }
  try {
    const raw = unwrapApplyPatchArguments(state.buffer)
    state.buffer = ''
    state.closed = true
    state.emitted += raw
    return raw
  } catch {
    return ''
  }
}

function isApplyPatchEnd(chunk: StreamChunkLike): chunk is StreamChunkLike & {
  block: { type: 'tool-call'; id?: unknown; name: string; arguments?: unknown; [key: string]: unknown }
} {
  if (chunk.type !== 'block-end' || typeof chunk.block !== 'object' || chunk.block === null) return false
  const block = chunk.block as { type?: unknown; name?: unknown }
  return block.type === 'tool-call'
    && block.name === APPLY_PATCH_TOOL_NAME
}

function rejectedApplyPatchEnd(index: unknown, id?: string): StreamChunkLike {
  return {
    type: 'block-end',
    index,
    block: {
      type: 'tool-call',
      id: id ?? syntheticToolCallId(),
      name: APPLY_PATCH_TOOL_NAME,
      arguments: REJECTED_APPLY_PATCH_ARGUMENTS,
    },
  }
}

function bridgeApplyPatchStartEvents(source: unknown): unknown {
  if (
    (typeof source !== 'object' && typeof source !== 'function')
    || source === null
    || typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
  ) return source

  return (async function* () {
    const applyPatchIds = new Map<number, string>()
    for await (const value of source as AsyncIterable<unknown>) {
      if (typeof value !== 'object' || value === null) {
        yield value
        continue
      }
      const event = value as {
        type?: unknown
        contentIndex?: unknown
        partial?: { content?: unknown }
        toolCall?: { id?: unknown; name?: unknown; [key: string]: unknown }
      }
      if ((event.type === 'done' || event.type === 'error') && applyPatchIds.size > 0) {
        for (const [contentIndex, id] of applyPatchIds) {
          yield {
            type: 'toolcall_end',
            contentIndex,
            toolCall: {
              type: 'toolCall',
              id,
              name: APPLY_PATCH_TOOL_NAME,
              arguments: { patch: REJECTED_APPLY_PATCH_ARGUMENTS },
            },
          }
        }
        applyPatchIds.clear()
        yield value
        continue
      }
      if (
        event.type !== 'toolcall_start'
        || typeof event.contentIndex !== 'number'
        || !Array.isArray(event.partial?.content)
      ) {
        const knownId = typeof event.contentIndex === 'number'
          ? applyPatchIds.get(event.contentIndex)
          : undefined
        if (event.type === 'toolcall_end' && knownId !== undefined) {
          applyPatchIds.delete(event.contentIndex as number)
          if (typeof event.toolCall !== 'object' || event.toolCall === null) {
            yield {
              type: 'toolcall_end',
              contentIndex: event.contentIndex,
              toolCall: {
                type: 'toolCall',
                id: knownId,
                name: APPLY_PATCH_TOOL_NAME,
                arguments: { patch: REJECTED_APPLY_PATCH_ARGUMENTS },
              },
            }
            continue
          }
          if (typeof event.toolCall.id !== 'string' || event.toolCall.id.length === 0) {
            yield {
              ...event,
              toolCall: { ...event.toolCall, id: knownId },
            }
            continue
          }
        }
        yield value
        continue
      }
      const content = event.partial.content
      const block = content[event.contentIndex] as {
        type?: unknown
        id?: unknown
        name?: unknown
        [key: string]: unknown
      } | undefined
      if (block?.type !== 'toolCall' || block.name !== APPLY_PATCH_TOOL_NAME) {
        yield value
        continue
      }
      const id = typeof block.id === 'string' && block.id.length > 0
        ? block.id
        : syntheticToolCallId()
      applyPatchIds.set(event.contentIndex, id)
      const partial = id === block.id
        ? event.partial
        : {
            ...event.partial,
            content: content.map((candidate, index) => index === event.contentIndex
              ? { ...block, id }
              : candidate),
          }
      yield partial === event.partial ? value : { ...event, partial }
      yield { type: 'toolcall_delta', contentIndex: event.contentIndex, delta: '', partial }
    }
  })()
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
    if (chunk.type === 'finish' && patchIndexes.size > 0) {
      for (const [index, state] of patchIndexes) {
        yield rejectedApplyPatchEnd(index, state.id) as T
      }
      patchIndexes.clear()
      yield value
      continue
    }
    if (
      chunk.type === 'tool-call-delta'
      && (chunk.name === APPLY_PATCH_TOOL_NAME || patchIndexes.has(chunk.index))
    ) {
      const existingState = patchIndexes.get(chunk.index)
      const state = existingState ?? {
        buffer: '',
        emitted: '',
        id: typeof chunk.id === 'string' && chunk.id.length > 0
          ? chunk.id
          : syntheticToolCallId(),
        mode: 'unknown',
        closed: false,
        rejected: false,
        sawArgumentBytes: false,
      }
      if (chunk.name !== undefined && chunk.name !== APPLY_PATCH_TOOL_NAME) state.rejected = true
      if (typeof chunk.id === 'string' && chunk.id.length > 0) {
        if (state.id !== chunk.id) state.rejected = true
      } else if (chunk.id !== undefined && chunk.id !== '') {
        state.rejected = true
      }
      patchIndexes.set(chunk.index, state)
      let argumentsDelta = ''
      if (!state.rejected && typeof chunk.argumentsDelta === 'string') {
        if (chunk.argumentsDelta.length > 0) state.sawArgumentBytes = true
        try {
          argumentsDelta = decodeApplyPatchDelta(chunk.argumentsDelta, state)
        } catch (error) {
          if (!(error instanceof PatchError)) throw error
          state.rejected = true
        }
      } else if (typeof chunk.argumentsDelta !== 'string') {
        state.rejected = true
      }
      yield {
        ...chunk,
        id: state.id,
        name: APPLY_PATCH_TOOL_NAME,
        argumentsDelta,
      } as unknown as T
      continue
    }
    const trackedState = patchIndexes.get(chunk.index)
    if (chunk.type === 'block-end' && trackedState !== undefined && !isApplyPatchEnd(chunk)) {
      patchIndexes.delete(chunk.index)
      yield rejectedApplyPatchEnd(chunk.index, trackedState.id) as T
      continue
    }
    if (isApplyPatchEnd(chunk)) {
      const state = trackedState
      let rejected = state?.rejected ?? false
      let finalPatch: string | undefined
      const finalId = typeof chunk.block.id === 'string' && chunk.block.id.length > 0
        ? chunk.block.id
        : undefined
      if (finalId === undefined) rejected = true
      if (state !== undefined && finalId !== state.id) rejected = true
      if (!rejected && typeof chunk.block.arguments === 'string') {
        try {
          finalPatch = unwrapApplyPatchArguments(chunk.block.arguments)
          if (state?.sawArgumentBytes) {
            const streamedPatch = state.mode === 'raw' || state.closed
              ? state.emitted
              : unwrapApplyPatchArguments(state.buffer)
            rejected = streamedPatch !== finalPatch
          }
        } catch (error) {
          if (!(error instanceof PatchError)) throw error
          rejected = true
        }
      } else {
        rejected = true
      }
      patchIndexes.delete(chunk.index)
      if (rejected || finalPatch === undefined) {
        yield rejectedApplyPatchEnd(chunk.index, state?.id ?? finalId) as T
        continue
      }
      yield {
        ...chunk,
        block: {
          ...chunk.block,
          arguments: finalPatch,
        },
      } as unknown as T
      continue
    }
    yield value
  }
  for (const [index, state] of patchIndexes) {
    yield rejectedApplyPatchEnd(index, state.id) as T
  }
}

/** Add pi-ai grammar metadata only to this plugin's single-string tool schema. */
export function withApplyPatchGrammar(context: PiContextLike, grammar: string): PiContextLike {
  let changed = false
  const bridgeTools = (tools: PiToolLike[]): PiToolLike[] => tools.map((tool) => {
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
  const tools = Array.isArray(context.tools) ? bridgeTools(context.tools) : context.tools
  // pi-ai 1.x also carries deferred tool declarations in system history.
  const messages = context.messages?.map(message => message.role === 'system' && Array.isArray(message.toolsAdded)
    ? { ...message, toolsAdded: bridgeTools(message.toolsAdded) }
    : message)
  return changed ? {
    ...context,
    ...(tools === undefined ? {} : { tools }),
    ...(messages === undefined ? {} : { messages }),
  } : context
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
          const stream = target.streamSimple(bridgedModel, bridgedContext, options)
          return bridgedContext === context ? stream : bridgeApplyPatchStartEvents(stream)
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
    throw new PatchError('dsh-smarter-edit: bundled freeform grammar is empty', 'PATCH_UNSUPPORTED')
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
      throw new PatchError('dsh-smarter-edit: conflicting pi-ai adapter prototype is already bridged', 'PATCH_UNSUPPORTED')
    }
    existing.references += 1
    return () => releaseBridge(existing)
  }

  const original = prototype.current
  if (typeof original !== 'function') {
    throw new PatchError(
      'dsh-smarter-edit: this dsh-llm-pi-ai version has no compatible current snapshot boundary',
      'PATCH_UNSUPPORTED',
    )
  }

  const bridgedSnapshots = new WeakMap<object, SnapshotLike>()
  const wrapper: CurrentSnapshot = function(this: unknown): SnapshotLike {
    const snapshot = original.call(this)
    if (typeof snapshot !== 'object' || snapshot === null || typeof snapshot.models !== 'object') {
      throw new PatchError('dsh-smarter-edit: pi-ai adapter returned an incompatible snapshot', 'PATCH_UNSUPPORTED')
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
      'dsh-smarter-edit: this dsh-llm-pi-ai version has no compatible stream boundary',
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
          'dsh-smarter-edit: pi-ai adapter returned an incompatible prepared call',
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
