import assert from 'node:assert/strict'
import test from 'node:test'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { stream as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import {
  bridgeSnapshot,
  installPiAiFreeformBridge,
  REJECTED_APPLY_PATCH_ARGUMENTS,
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

test('snapshot bridge preserves apply_patch identity for a zero-delta pi-ai call', async () => {
  const start = {
    type: 'toolcall_start',
    contentIndex: 0,
    partial: {
      content: [{
        type: 'toolCall',
        id: 'call-zero-delta',
        name: 'apply_patch',
        arguments: {},
      }],
    },
  }
  async function* source() {
    yield start
    yield { type: 'done' }
  }
  const models = {
    streamSimple() {
      return source()
    },
  }
  const snapshot = bridgeSnapshot({ models }, 'start: "x"')
  const events = []
  for await (const event of snapshot.models.streamSimple(
    { compat: {} },
    { tools: [patchTool] },
    {},
  )) events.push(event)

  assert.equal(events[0], start)
  assert.deepEqual(events[1], {
    type: 'toolcall_delta',
    contentIndex: 0,
    delta: '',
    partial: start.partial,
  })
  assert.deepEqual(events[2], {
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: {
      type: 'toolCall',
      id: 'call-zero-delta',
      name: 'apply_patch',
      arguments: { patch: REJECTED_APPLY_PATCH_ARGUMENTS },
    },
  })
  assert.deepEqual(events[3], { type: 'done' })
})

test('snapshot bridge supplies one stable non-empty ID when pi-ai omits it', async () => {
  const start = {
    type: 'toolcall_start',
    contentIndex: 0,
    partial: {
      content: [{
        type: 'toolCall',
        id: '',
        name: 'apply_patch',
        arguments: {},
      }],
    },
  }
  const end = {
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: {
      type: 'toolCall',
      id: '',
      name: 'apply_patch',
      arguments: {},
    },
  }
  async function* source() {
    yield start
    yield end
  }
  const models = {
    streamSimple() {
      return source()
    },
  }
  const snapshot = bridgeSnapshot({ models }, 'start: "x"')
  const events = []
  for await (const event of snapshot.models.streamSimple(
    { compat: {} },
    { tools: [patchTool] },
    {},
  )) events.push(event)

  const generatedId = events[0].partial.content[0].id
  assert.match(generatedId, /^call_dsh_[a-f0-9]{32}$/u)
  assert.equal(events[1].partial.content[0].id, generatedId)
  assert.equal(events[2].toolCall.id, generatedId)
  assert.equal(start.partial.content[0].id, '')
  assert.equal(end.toolCall.id, '')
})

test('snapshot bridge replaces a malformed pi-ai end before adapter conversion', async () => {
  const start = {
    type: 'toolcall_start',
    contentIndex: 0,
    partial: {
      content: [{
        type: 'toolCall',
        id: 'call-malformed-end',
        name: 'apply_patch',
        arguments: {},
      }],
    },
  }
  async function* source() {
    yield start
    yield { type: 'toolcall_end', contentIndex: 0 }
  }
  const snapshot = bridgeSnapshot({
    models: {
      streamSimple() {
        return source()
      },
    },
  }, 'start: "x"')
  const events = []
  for await (const event of snapshot.models.streamSimple(
    { compat: {} },
    { tools: [patchTool] },
    {},
  )) events.push(event)

  assert.deepEqual(events[2], {
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: {
      type: 'toolCall',
      id: 'call-malformed-end',
      name: 'apply_patch',
      arguments: { patch: REJECTED_APPLY_PATCH_ARGUMENTS },
    },
  })
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

test('pi-ai serializes the enriched schema as a Chat Completions custom tool', async () => {
  let payload
  const grammar = 'start: "*** Begin Patch" LF "*** End Patch" LF?\n%import common.LF\n'
  const context = withApplyPatchGrammar({ messages: [], tools: [patchTool] }, grammar)
  const model = {
    id: 'deepseek-test',
    name: 'deepseek-test',
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
    compat: { supportsOpenAIGrammarTools: true },
  }
  const events = streamOpenAICompletions(model, context, {
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
    custom: {
      name: 'apply_patch',
      description: 'patch',
      format: {
        type: 'grammar',
        grammar: { syntax: 'lark', definition: grammar },
      },
    },
  }])
  assert.equal('function' in payload.tools[0], false)
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
      id: 'call-1',
      name: 'apply_patch',
      argumentsDelta: `{"patch":"${JSON.stringify(first).slice(1, -1)}`,
    }
    yield {
      type: 'tool-call-delta',
      index: 1,
      id: 'call-1',
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
  assert.equal(unwrapApplyPatchArguments(`  ${patch}`), `  ${patch}`)
  for (const outer of ['patch', 'input', 'arguments']) {
    assert.equal(unwrapApplyPatchArguments(JSON.stringify({ [outer]: patch })), patch)
    for (const inner of ['patch', 'input', 'arguments']) {
      assert.equal(
        unwrapApplyPatchArguments(JSON.stringify({
          [outer]: JSON.stringify({ [inner]: patch }),
        })),
        patch,
      )
    }
  }
  assert.equal(unwrapApplyPatchArguments(JSON.stringify({ arguments: `  ${patch}` })), `  ${patch}`)
  const punctuationPatch = '*** Begin Patch\n*** Add File: punctuation.txt\n+comma, quote " and slash \\\n*** End Patch'
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({ arguments: punctuationPatch })),
    punctuationPatch,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({ patch, extra: true })),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({ input: patch, extra: true })),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({ arguments: patch, extra: true })),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({ patch: { text: patch } })),
    /JSON object with 1 field\(s\) \("patch":object\)/u,
  )
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({
      arguments: JSON.stringify({ patch }),
    })),
    patch,
  )
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({
      arguments: JSON.stringify({ input: patch }),
    })),
    patch,
  )
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({
      arguments: JSON.stringify({ arguments: JSON.stringify({ patch }) }),
    })),
    patch,
  )
  let deeplyNested = patch
  for (let index = 0; index < 5; index += 1) {
    deeplyNested = JSON.stringify({ arguments: deeplyNested })
  }
  assert.equal(unwrapApplyPatchArguments(deeplyNested), patch)
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({ arguments: patch, patch })),
    patch,
  )
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({
      arguments: JSON.stringify({ patch }),
      patch,
    })),
    patch,
  )
  assert.equal(
    unwrapApplyPatchArguments(JSON.stringify({
      arguments: patch,
      patch: JSON.stringify({ input: patch }),
      input: JSON.stringify({ arguments: patch }),
    })),
    patch,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({
      arguments: JSON.stringify({ patch }),
      patch: `${patch}\n`,
    })),
    /expected raw custom-tool input/u,
  )
  for (const key of ['patch', 'input', 'arguments']) {
    assert.throws(
      () => unwrapApplyPatchArguments(JSON.stringify({
        [key]: `tool input:\n${patch}`,
      })),
      /string\(patch marker at offset 12\)/u,
    )
    assert.throws(
      () => unwrapApplyPatchArguments(JSON.stringify({ [key]: 'not a patch' })),
      /expected raw custom-tool input/u,
    )
  }
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({
      arguments: JSON.stringify({ payload: patch }),
    })),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({
      arguments: `{"patch":"ignored","patch":${JSON.stringify(patch)}}`,
    })),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({
      arguments: '{"patch":',
    })),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments(JSON.stringify({ '*** Begin Patch\nsecret': patch })),
    error => error.message.includes('"<unknown>":string') && !error.message.includes('secret'),
  )
  for (const key of ['patch', 'input', 'arguments']) {
    assert.throws(
      () => unwrapApplyPatchArguments(
        `{${JSON.stringify(key)}:"ignored",${JSON.stringify(key)}:${JSON.stringify(patch)}}`,
      ),
      /expected raw custom-tool input/u,
    )
  }
  assert.throws(
    () => unwrapApplyPatchArguments(
      `{"p\\u0061tch":"ignored","patch":${JSON.stringify(patch)}}`,
    ),
    /expected raw custom-tool input/u,
  )
  assert.throws(
    () => unwrapApplyPatchArguments('{"patch":'),
    /expected raw custom-tool input/u,
  )
})

test('accepts a final raw patch after an identity-only empty delta', async () => {
  const patch = '*** Begin Patch\n*** Add File: final-only.txt\n+final\n*** End Patch'
  async function* source() {
    yield {
      type: 'block-start',
      index: 0,
      blockType: 'tool-call',
    }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'call-final-only',
      name: 'apply_patch',
      argumentsDelta: '',
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'call-final-only',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch }),
      },
    }
  }

  const chunks = []
  for await (const chunk of unwrapApplyPatchStream(source())) chunks.push(chunk)
  assert.equal(chunks.at(-1).block.arguments, patch)
})

test('restores raw patch input from pi-ai fallback envelopes', async () => {
  const patch = '*** Begin Patch\n*** Add File: fallback.txt\n+fallback\n*** End Patch'
  const envelope = JSON.stringify({ input: patch })
  async function* source() {
    for (const [index, character] of [...envelope].entries()) {
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-1',
        ...(index === 0 ? { name: 'apply_patch' } : {}),
        argumentsDelta: character,
      }
    }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: 'call-1',
        name: 'apply_patch',
        arguments: envelope,
      },
    }
  }

  const chunks = []
  for await (const chunk of unwrapApplyPatchStream(source())) chunks.push(chunk)
  assert.equal(chunks
    .filter(chunk => chunk.type === 'tool-call-delta')
    .map(chunk => chunk.argumentsDelta).join(''), patch)
  assert.equal(chunks.at(-1).block.arguments, patch)
})

test('restores DeepSeek raw patch input from its function-argument fallback', async () => {
  const patch = '  *** Begin Patch\n*** Add File: deepseek.txt\n+deepseek\n*** End Patch'
  const envelope = JSON.stringify({ arguments: patch })
  async function* source() {
    for (const [index, character] of [...envelope].entries()) {
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-1',
        ...(index === 0 ? { name: 'apply_patch' } : {}),
        argumentsDelta: character,
      }
    }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: 'call-1',
        name: 'apply_patch',
        arguments: envelope,
      },
    }
  }

  const chunks = []
  for await (const chunk of unwrapApplyPatchStream(source())) chunks.push(chunk)
  assert.equal(chunks
    .filter(chunk => chunk.type === 'tool-call-delta')
    .map(chunk => chunk.argumentsDelta).join(''), patch)
  assert.equal(chunks.at(-1).block.arguments, patch)
})

test('restores nested and agreeing DeepSeek patch argument fallbacks', async () => {
  const patch = '*** Begin Patch\n*** Add File: deepseek-nested.txt\n+deepseek\n*** End Patch'
  for (const envelope of [
    JSON.stringify({ arguments: JSON.stringify({ patch }) }),
    JSON.stringify({ arguments: patch, patch }),
    JSON.stringify({ arguments: JSON.stringify({ patch }), patch }),
  ]) {
    async function* source() {
      for (const [index, character] of [...envelope].entries()) {
        yield {
          type: 'tool-call-delta',
          index: 1,
          id: 'call-1',
          ...(index === 0 ? { name: 'apply_patch' } : {}),
          argumentsDelta: character,
        }
      }
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'call-1',
          name: 'apply_patch',
          arguments: envelope,
        },
      }
    }

    const chunks = []
    for await (const chunk of unwrapApplyPatchStream(source())) chunks.push(chunk)
    assert.equal(chunks
      .filter(chunk => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.argumentsDelta).join(''), patch)
    assert.equal(chunks.at(-1).block.arguments, patch)
  }
})

test('turns mismatched, invalid, and truncated patch streams into rejected tool calls', async () => {
  const patchA = '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch'
  const patchB = '*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch'
  const deltaEnvelope = JSON.stringify({ arguments: JSON.stringify({ patch: patchA }) })
  const finalEnvelope = JSON.stringify({ patch: patchB })
  const deltaChunk = {
    type: 'tool-call-delta',
    index: 1,
    id: 'call-1',
    name: 'apply_patch',
    argumentsDelta: deltaEnvelope,
  }
  const finalChunk = {
    type: 'block-end',
    index: 1,
    block: {
      type: 'tool-call',
      id: 'call-1',
      name: 'apply_patch',
      arguments: finalEnvelope,
    },
  }
  async function* mismatched() {
    yield deltaChunk
    yield finalChunk
  }
  const mismatchedChunks = []
  for await (const chunk of unwrapApplyPatchStream(mismatched())) mismatchedChunks.push(chunk)
  assert.equal(mismatchedChunks.at(-1).block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)
  assert.equal(deltaChunk.argumentsDelta, deltaEnvelope)
  assert.equal(finalChunk.block.arguments, finalEnvelope)

  async function* invalidThenFinal() {
    yield {
      type: 'tool-call-delta',
      index: 1,
      id: 'call-2',
      name: 'apply_patch',
      argumentsDelta: '{"arguments":false}',
    }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: 'call-2',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: patchA }),
      },
    }
  }
  const invalidChunks = []
  for await (const chunk of unwrapApplyPatchStream(invalidThenFinal())) invalidChunks.push(chunk)
  assert.equal(invalidChunks.at(-1).block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)

  for (const argumentsDelta of ['{"arguments":false}', patchA]) {
    async function* truncated() {
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-truncated',
        name: 'apply_patch',
        argumentsDelta,
      }
    }
    const truncatedChunks = []
    for await (const chunk of unwrapApplyPatchStream(truncated())) truncatedChunks.push(chunk)
    assert.equal(truncatedChunks.at(-1).type, 'block-end')
    assert.equal(truncatedChunks.at(-1).block.id, 'call-truncated')
    assert.equal(truncatedChunks.at(-1).block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)
  }

  async function* finishedWithoutEnd() {
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 1,
      id: 'call-before-finish',
      name: 'apply_patch',
      argumentsDelta: patchA,
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const finishedChunks = []
  for await (const chunk of unwrapApplyPatchStream(finishedWithoutEnd())) finishedChunks.push(chunk)
  assert.equal(finishedChunks.at(-2).type, 'block-end')
  assert.equal(finishedChunks.at(-2).block.id, 'call-before-finish')
  assert.equal(finishedChunks.at(-2).block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)
  assert.equal(finishedChunks.at(-1).type, 'finish')

  async function* nonStringFinal() {
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: 'call-non-string',
        name: 'apply_patch',
        arguments: { patch: patchA },
      },
    }
  }
  const nonStringChunks = []
  for await (const chunk of unwrapApplyPatchStream(nonStringFinal())) nonStringChunks.push(chunk)
  assert.equal(nonStringChunks[0].block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)

  async function* emptyIdFinal() {
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: '',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: patchA }),
      },
    }
  }
  const emptyIdChunks = []
  for await (const chunk of unwrapApplyPatchStream(emptyIdFinal())) emptyIdChunks.push(chunk)
  assert.equal(emptyIdChunks[0].block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)
  assert.match(emptyIdChunks[0].block.id, /^call_dsh_[a-f0-9]{32}$/u)

  async function* missingId() {
    yield {
      type: 'tool-call-delta',
      index: 1,
      name: 'apply_patch',
      argumentsDelta: patchA,
    }
  }
  const missingIdChunks = []
  for await (const chunk of unwrapApplyPatchStream(missingId())) missingIdChunks.push(chunk)
  const deltaId = missingIdChunks[0].id
  const generatedId = missingIdChunks.at(-1).block.id
  assert.match(generatedId, /^call_dsh_[a-f0-9]{32}$/u)
  assert.equal(deltaId, generatedId)

  async function* lateIdFinal() {
    yield {
      type: 'tool-call-delta',
      index: 1,
      name: 'apply_patch',
      argumentsDelta: patchA,
    }
    yield {
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: 'call-late',
        name: 'apply_patch',
        arguments: patchA,
      },
    }
  }
  const lateIdChunks = []
  for await (const chunk of unwrapApplyPatchStream(lateIdFinal())) lateIdChunks.push(chunk)
  assert.match(lateIdChunks[0].id, /^call_dsh_[a-f0-9]{32}$/u)
  assert.equal(lateIdChunks.at(-1).block.id, lateIdChunks[0].id)
  assert.equal(lateIdChunks.at(-1).block.arguments, REJECTED_APPLY_PATCH_ARGUMENTS)
})

test('rejects apply_patch call identity and block-type conflicts exactly once', async () => {
  const patch = '*** Begin Patch\n*** Add File: identity.txt\n+x\n*** End Patch'
  const cases = [
    [
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-a',
        name: 'apply_patch',
        argumentsDelta: patch,
      },
      {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'call-b',
          name: 'apply_patch',
          arguments: patch,
        },
      },
    ],
    [
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-a',
        name: 'apply_patch',
        argumentsDelta: patch,
      },
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-a',
        name: 'read',
        argumentsDelta: '',
      },
      {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'call-a',
          name: 'apply_patch',
          arguments: patch,
        },
      },
    ],
    [
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-a',
        name: 'apply_patch',
        argumentsDelta: patch,
      },
      {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'call-a',
          name: 'read',
          arguments: '{"path":"identity.txt"}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    [
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-a',
        name: 'apply_patch',
        argumentsDelta: patch,
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'text', text: patch },
      },
    ],
  ]

  for (const input of cases) {
    async function* source() {
      yield* input
    }
    const chunks = []
    for await (const chunk of unwrapApplyPatchStream(source())) chunks.push(chunk)
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    assert.equal(ends.length, 1)
    assert.deepEqual(ends[0].block, {
      type: 'tool-call',
      id: 'call-a',
      name: 'apply_patch',
      arguments: REJECTED_APPLY_PATCH_ARGUMENTS,
    })
  }
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
