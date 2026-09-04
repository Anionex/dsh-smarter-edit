import assert from 'node:assert/strict'
import test from 'node:test'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import {
  bridgeSnapshot,
  installPiAiFreeformBridge,
  rewrapApplyPatchHistory,
  unwrapApplyPatchArguments,
  unwrapApplyPatchStream,
  withApplyPatchGrammar,
} from '../lib/freeform-bridge.js'

const patchTool = {
  name: 'apply_patch',
  description: 'patch',
  parameters: {
    type: 'object',
    properties: { patch: { type: 'string' } },
    required: ['patch'],
  },
}

test('adds custom grammar metadata only to apply_patch', () => {
  const other = { name: 'read', parameters: { type: 'object', properties: {} } }
  const context = { messages: [], tools: [other, patchTool] }
  const bridged = withApplyPatchGrammar(context, 'start: "x"')
  assert.notEqual(bridged, context)
  assert.equal(bridged.tools[0], other)
  assert.deepEqual(bridged.tools[1].constrainedSampling, {
    type: 'grammar',
    variants: { openai_lark: 'start: "x"' },
  })
})

test('snapshot bridge forces raw grammar transport without a model capability gate', () => {
  let captured
  let capturedModel
  const models = {
    marker: 'bound',
    streamSimple(model, context) {
      capturedModel = model
      captured = context
      return 'stream'
    },
    markerValue() {
      return this.marker
    },
  }
  const snapshot = bridgeSnapshot({ models }, 'start: "x"')

  assert.equal(snapshot.models.markerValue(), 'bound')
  assert.equal(snapshot.models.streamSimple(
    { compat: { supportsOpenAIGrammarTools: true } },
    { tools: [patchTool] },
    {},
  ), 'stream')
  assert.equal(captured.tools[0].constrainedSampling.type, 'grammar')
  assert.equal(capturedModel.compat.supportsOpenAIGrammarTools, true)
  assert.equal(snapshot.models.streamSimple(
    { compat: { supportsOpenAIGrammarTools: false } },
    { tools: [patchTool] },
    {},
  ), 'stream')
  assert.equal(capturedModel.compat.supportsOpenAIGrammarTools, true)
})

test('pi-ai serializes the enriched schema as an OpenAI custom tool on the wire', async () => {
  let payload
  const grammar = 'start: "*** Begin Patch" LF "*** End Patch" LF?\n%import common.LF\n'
  const context = withApplyPatchGrammar({ messages: [], tools: [patchTool] }, grammar)
  const model = {
    id: 'gpt-test',
    name: 'gpt-test',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
    compat: { supportsOpenAIGrammarTools: true },
  }
  const events = streamOpenAIResponses(model, context, {
    apiKey: 'test-key',
    onPayload(value) {
      payload = value
      throw new Error('payload captured before network')
    },
  })
  for await (const _event of events) {
    // Drain the expected adapter error after onPayload captures the request.
  }
  assert.deepEqual(payload.tools, [{
    type: 'custom',
    name: 'apply_patch',
    description: 'patch',
    format: { type: 'grammar', syntax: 'lark', definition: grammar },
  }])
  assert.equal('parameters' in payload.tools[0], false)
})

test('restores raw patch deltas and final arguments without touching other chunks', async () => {
  const patch = '*** Begin Patch\n*** Add File: src/a.ts\n+const value = "x\\\\y"\n*** End Patch\n'
  const cut = patch.indexOf('+const')
  const first = patch.slice(0, cut)
  const second = patch.slice(cut)
  const untouched = { type: 'text-delta', index: 0, text: 'before' }
  async function* source() {
    yield untouched
    yield {
      type: 'tool-call-delta',
      index: 1,
      name: 'apply_patch',
      argumentsDelta: `{"patch":"${JSON.stringify(first).slice(1, -1)}`,
    }
    yield {
      type: 'tool-call-delta',
      index: 1,
      argumentsDelta: `${JSON.stringify(second).slice(1, -1)}"}`,
    }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: 'call-1',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch }),
      },
    }
  }

  const chunks = []
  for await (const chunk of unwrapApplyPatchStream(source())) chunks.push(chunk)
  assert.equal(chunks[0], untouched)
  assert.equal(chunks[1].argumentsDelta + chunks[2].argumentsDelta, patch)
  assert.equal(chunks[3].block.arguments, patch)
  assert.equal(unwrapApplyPatchArguments(patch), patch)
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({ patch, extra: true })),
    /expected raw custom-tool input/u,
  )
})

test('rewraps only raw historical apply_patch calls for pi-ai replay', () => {
  const patch = '*** Begin Patch\n*** Add File: replay.txt\n+replay\n*** End Patch'
  const untouched = { type: 'text', text: 'before' }
  const options = {
    messages: [{
      role: 'assistant',
      content: [
        untouched,
        { type: 'tool-call', id: 'call-1', name: 'apply_patch', arguments: patch },
        { type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"path":"a"}' },
      ],
    }],
  }
  const bridged = rewrapApplyPatchHistory(options)
  assert.notEqual(bridged, options)
  assert.equal(bridged.messages[0].content[0], untouched)
  assert.deepEqual(JSON.parse(bridged.messages[0].content[1].arguments), { patch })
  assert.equal(bridged.messages[0].content[2], options.messages[0].content[2])
  assert.equal(rewrapApplyPatchHistory({ messages: [] }).messages.length, 0)
})

test('installs a reference-counted reversible pi-ai request and replay bridge', async () => {
  const prototype = PiAiAdapter.prototype
  const originalCurrent = prototype.current
  const originalPrepareCall = prototype.prepareCall
  const originalStream = prototype.stream
  assert.equal(typeof originalCurrent, 'function')
  assert.equal(typeof originalStream, 'function')
  const releaseOne = await installPiAiFreeformBridge()
  const wrappedCurrent = prototype.current
  const wrappedPrepareCall = prototype.prepareCall
  const wrappedStream = prototype.stream
  assert.notEqual(wrappedCurrent, originalCurrent)
  if (Object.hasOwn(prototype, 'prepareCall')) assert.notEqual(wrappedPrepareCall, originalPrepareCall)
  assert.notEqual(wrappedStream, originalStream)
  const releaseTwo = await installPiAiFreeformBridge()
  assert.equal(prototype.current, wrappedCurrent)
  assert.equal(prototype.prepareCall, wrappedPrepareCall)
  assert.equal(prototype.stream, wrappedStream)
  releaseOne()
  assert.equal(prototype.current, wrappedCurrent)
  assert.equal(prototype.prepareCall, wrappedPrepareCall)
  assert.equal(prototype.stream, wrappedStream)
  releaseTwo()
  assert.equal(prototype.current, originalCurrent)
  assert.equal(prototype.prepareCall, originalPrepareCall)
  assert.equal(prototype.stream, originalStream)
})

test('rewraps history through pi-ai prepared-call streams', async () => {
  const prototype = PiAiAdapter.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'prepareCall')
  let captured
  Object.defineProperty(prototype, 'prepareCall', {
    configurable: true,
    writable: true,
    async value() {
      return {
        model: {},
        stream(options) {
          captured = options
          return (async function* empty() {})()
        },
      }
    },
  })
  let release
  try {
    release = await installPiAiFreeformBridge()
    const patch = '*** Begin Patch\n*** Add File: prepared.txt\n+prepared\n*** End Patch'
    const options = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'apply_patch', arguments: patch }],
      }],
    }
    const prepared = await prototype.prepareCall.call({}, 'provider', 'model')
    prepared.stream(options)
    assert.deepEqual(JSON.parse(captured.messages[0].content[0].arguments), { patch })
  } finally {
    release?.()
    if (descriptor === undefined) delete prototype.prepareCall
    else Object.defineProperty(prototype, 'prepareCall', descriptor)
  }
})
