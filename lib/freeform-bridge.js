import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PatchError } from './errors.js';
export const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const STATE_KEY = Symbol.for('@anionex/dsh-smarter-edit/pi-ai-freeform-bridge');
const globalBridge = globalThis;
/**
 * Provider routes observed on the pi-ai adapter during this process.
 *
 * The adapter is the only boundary that can emit the apply_patch grammar tool,
 * so a provider id recorded here is one whose requests really carry freeform
 * patch text. Session headers name their provider, which makes this set the
 * honest answer to "is this session on the recommended configuration".
 */
const freeformRoutedProviders = new Set();
function noteFreeformRoute(options) {
    if (typeof options !== 'object' || options === null)
        return;
    const provider = options.provider;
    if (typeof provider === 'string' && provider.length > 0)
        freeformRoutedProviders.add(provider);
}
/** Whether requests for `provider` have been seen flowing through the pi-ai adapter. */
export function providerUsesFreeformTransport(provider) {
    return provider !== undefined && freeformRoutedProviders.has(provider);
}
/** Test-only: forget the observed provider routes. */
export function resetFreeformTransportObservation() {
    freeformRoutedProviders.clear();
}
function isPatchStringSchema(parameters) {
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters))
        return false;
    const schema = parameters;
    if (schema.type !== 'object' || !Array.isArray(schema.required) || !schema.required.includes('patch'))
        return false;
    if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties))
        return false;
    const patch = schema.properties.patch;
    return typeof patch === 'object' && patch !== null && !Array.isArray(patch)
        && patch.type === 'string';
}
const KNOWN_PATCH_ARGUMENT_NAMES = new Set(['patch', 'input', 'arguments']);
export const REJECTED_APPLY_PATCH_ARGUMENTS = [
    '*** Begin Patch',
    '*** Invalid Tool Input: retry apply_patch with raw patch text, without JSON or a patch field',
    '*** End Patch',
].join('\n');
function syntheticToolCallId() {
    return `call_dsh_${randomUUID().replaceAll('-', '')}`;
}
function describePatchString(value) {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('*** Begin Patch'))
        return 'string(raw patch)';
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed))
            return `string containing JSON array with ${parsed.length} item(s)`;
        if (typeof parsed !== 'object' || parsed === null) {
            return `string containing JSON ${parsed === null ? 'null' : typeof parsed}`;
        }
        const entries = Object.entries(parsed);
        const fields = entries.slice(0, 4).map(([key, nestedValue]) => {
            const displayedKey = KNOWN_PATCH_ARGUMENT_NAMES.has(key) ? JSON.stringify(key) : '"<unknown>"';
            const valueType = typeof nestedValue === 'string'
                && nestedValue.trimStart().startsWith('*** Begin Patch')
                ? 'string(raw patch)'
                : Array.isArray(nestedValue)
                    ? 'array'
                    : nestedValue === null
                        ? 'null'
                        : typeof nestedValue;
            return `${displayedKey}:${valueType}`;
        });
        return `string containing JSON object with ${entries.length} field(s)${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`;
    }
    catch {
        const markerOffset = value.indexOf('*** Begin Patch');
        return markerOffset >= 0
            ? `string(patch marker at offset ${markerOffset})`
            : `string(${value.length} chars)`;
    }
}
function describePatchArguments(serialized) {
    try {
        const parsed = JSON.parse(serialized);
        if (Array.isArray(parsed))
            return `JSON array with ${parsed.length} item(s)`;
        if (typeof parsed !== 'object' || parsed === null)
            return `JSON ${parsed === null ? 'null' : typeof parsed}`;
        const entries = Object.entries(parsed);
        const fields = entries.slice(0, 4).map(([key, value]) => {
            const valueType = typeof value === 'string' && KNOWN_PATCH_ARGUMENT_NAMES.has(key)
                ? describePatchString(value)
                : Array.isArray(value)
                    ? 'array'
                    : value === null
                        ? 'null'
                        : typeof value;
            const displayedKey = KNOWN_PATCH_ARGUMENT_NAMES.has(key) ? JSON.stringify(key) : '"<unknown>"';
            return `${displayedKey}:${valueType}`;
        });
        return `JSON object with ${entries.length} field(s)${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`;
    }
    catch {
        return `non-JSON text (${serialized.length} chars)`;
    }
}
function countTopLevelJsonMembers(serialized) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let memberCount = 0;
    for (const character of serialized) {
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"')
            inString = true;
        else if (character === '{' || character === '[')
            depth += 1;
        else if (character === '}' || character === ']')
            depth -= 1;
        else if (character === ':' && depth === 1)
            memberCount += 1;
    }
    return memberCount;
}
function tryUnwrapApplyPatchArguments(serialized) {
    if (serialized.trimStart().startsWith('*** Begin Patch'))
        return serialized;
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return undefined;
    const entries = Object.entries(parsed);
    if (entries.length === 0
        || countTopLevelJsonMembers(serialized) !== entries.length
        || entries.some(([key, value]) => !KNOWN_PATCH_ARGUMENT_NAMES.has(key) || typeof value !== 'string')) {
        return undefined;
    }
    const candidates = [];
    for (const [, value] of entries) {
        if (value.trimStart().startsWith('*** Begin Patch')) {
            candidates.push(value);
            continue;
        }
        const nested = tryUnwrapApplyPatchArguments(value);
        if (nested === undefined || !nested.trimStart().startsWith('*** Begin Patch'))
            return undefined;
        candidates.push(nested);
    }
    const [candidate] = candidates;
    if (candidate === undefined
        || candidates.some(value => value !== candidate)) {
        return undefined;
    }
    return candidate;
}
/** Recover raw custom-tool input from pi-ai and provider fallback envelopes. */
export function unwrapApplyPatchArguments(serialized) {
    const patch = tryUnwrapApplyPatchArguments(serialized);
    if (patch !== undefined)
        return patch;
    throw new PatchError(`dsh-smarter-edit: pi-ai did not return the expected raw custom-tool input; received ${describePatchArguments(serialized)}`, 'PATCH_UNSUPPORTED');
}
/** Restore raw durable calls to pi-ai's internal grammar-tool envelope for replay. */
export function rewrapApplyPatchHistory(options) {
    if (typeof options !== 'object' || options === null || !Array.isArray(options.messages)) {
        return options;
    }
    let changed = false;
    const messages = options.messages.map(message => {
        if (typeof message !== 'object'
            || message === null
            || message.role !== 'assistant'
            || !Array.isArray(message.content))
            return message;
        let contentChanged = false;
        const content = message.content.map(block => {
            if (typeof block !== 'object'
                || block === null
                || block.type !== 'tool-call'
                || block.name !== APPLY_PATCH_TOOL_NAME
                || typeof block.arguments !== 'string')
                return block;
            const raw = block.arguments;
            if (!raw.trimStart().startsWith('*** Begin Patch'))
                return block;
            contentChanged = true;
            return { ...block, arguments: JSON.stringify({ patch: raw }) };
        });
        if (!contentChanged)
            return message;
        changed = true;
        return { ...message, content };
    });
    return changed ? { ...options, messages } : options;
}
function decodeApplyPatchDelta(delta, state) {
    if (state.closed) {
        if (delta.trim().length === 0)
            return '';
        throw new PatchError('dsh-smarter-edit: model emitted patch input after closing it', 'PATCH_UNSUPPORTED');
    }
    if (state.mode === 'raw') {
        state.emitted += delta;
        return delta;
    }
    state.buffer += delta;
    if (state.mode === 'unknown') {
        const trimmed = state.buffer.trimStart();
        if (trimmed === '')
            return '';
        if (trimmed.startsWith('{')) {
            state.mode = 'json';
        }
        else if ('*** Begin Patch'.startsWith(trimmed)) {
            return '';
        }
        else if (trimmed.startsWith('*** Begin Patch')) {
            state.mode = 'raw';
            const raw = state.buffer;
            state.buffer = '';
            state.emitted += raw;
            return raw;
        }
        else {
            throw new PatchError('dsh-smarter-edit: model changed its patch-tool streaming envelope', 'PATCH_UNSUPPORTED');
        }
    }
    try {
        const raw = unwrapApplyPatchArguments(state.buffer);
        state.buffer = '';
        state.closed = true;
        state.emitted += raw;
        return raw;
    }
    catch {
        return '';
    }
}
function isApplyPatchEnd(chunk) {
    if (chunk.type !== 'block-end' || typeof chunk.block !== 'object' || chunk.block === null)
        return false;
    const block = chunk.block;
    return block.type === 'tool-call'
        && block.name === APPLY_PATCH_TOOL_NAME;
}
function rejectedApplyPatchEnd(index, id) {
    return {
        type: 'block-end',
        index,
        block: {
            type: 'tool-call',
            id: id ?? syntheticToolCallId(),
            name: APPLY_PATCH_TOOL_NAME,
            arguments: REJECTED_APPLY_PATCH_ARGUMENTS,
        },
    };
}
function bridgeApplyPatchStartEvents(source) {
    if ((typeof source !== 'object' && typeof source !== 'function')
        || source === null
        || typeof source[Symbol.asyncIterator] !== 'function')
        return source;
    return (async function* () {
        const applyPatchIds = new Map();
        for await (const value of source) {
            if (typeof value !== 'object' || value === null) {
                yield value;
                continue;
            }
            const event = value;
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
                    };
                }
                applyPatchIds.clear();
                yield value;
                continue;
            }
            if (event.type !== 'toolcall_start'
                || typeof event.contentIndex !== 'number'
                || !Array.isArray(event.partial?.content)) {
                const knownId = typeof event.contentIndex === 'number'
                    ? applyPatchIds.get(event.contentIndex)
                    : undefined;
                if (event.type === 'toolcall_end' && knownId !== undefined) {
                    applyPatchIds.delete(event.contentIndex);
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
                        };
                        continue;
                    }
                    if (typeof event.toolCall.id !== 'string' || event.toolCall.id.length === 0) {
                        yield {
                            ...event,
                            toolCall: { ...event.toolCall, id: knownId },
                        };
                        continue;
                    }
                }
                yield value;
                continue;
            }
            const content = event.partial.content;
            const block = content[event.contentIndex];
            if (block?.type !== 'toolCall' || block.name !== APPLY_PATCH_TOOL_NAME) {
                yield value;
                continue;
            }
            const id = typeof block.id === 'string' && block.id.length > 0
                ? block.id
                : syntheticToolCallId();
            applyPatchIds.set(event.contentIndex, id);
            const partial = id === block.id
                ? event.partial
                : {
                    ...event.partial,
                    content: content.map((candidate, index) => index === event.contentIndex
                        ? { ...block, id }
                        : candidate),
                };
            yield partial === event.partial ? value : { ...event, partial };
            yield { type: 'toolcall_delta', contentIndex: event.contentIndex, delta: '', partial };
        }
    })();
}
/**
 * Restore raw apply_patch input before DSH assembles or persists the ToolCallBlock.
 * Other chunks retain object identity; apply_patch deltas and final blocks are cloned.
 */
export async function* unwrapApplyPatchStream(source) {
    const patchIndexes = new Map();
    for await (const value of source) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            yield value;
            continue;
        }
        const chunk = value;
        if (chunk.type === 'finish' && patchIndexes.size > 0) {
            for (const [index, state] of patchIndexes) {
                yield rejectedApplyPatchEnd(index, state.id);
            }
            patchIndexes.clear();
            yield value;
            continue;
        }
        if (chunk.type === 'tool-call-delta'
            && (chunk.name === APPLY_PATCH_TOOL_NAME || patchIndexes.has(chunk.index))) {
            const existingState = patchIndexes.get(chunk.index);
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
            };
            if (chunk.name !== undefined && chunk.name !== APPLY_PATCH_TOOL_NAME)
                state.rejected = true;
            if (typeof chunk.id === 'string' && chunk.id.length > 0) {
                if (state.id !== chunk.id)
                    state.rejected = true;
            }
            else if (chunk.id !== undefined && chunk.id !== '') {
                state.rejected = true;
            }
            patchIndexes.set(chunk.index, state);
            let argumentsDelta = '';
            if (!state.rejected && typeof chunk.argumentsDelta === 'string') {
                if (chunk.argumentsDelta.length > 0)
                    state.sawArgumentBytes = true;
                try {
                    argumentsDelta = decodeApplyPatchDelta(chunk.argumentsDelta, state);
                }
                catch (error) {
                    if (!(error instanceof PatchError))
                        throw error;
                    state.rejected = true;
                }
            }
            else if (typeof chunk.argumentsDelta !== 'string') {
                state.rejected = true;
            }
            yield {
                ...chunk,
                id: state.id,
                name: APPLY_PATCH_TOOL_NAME,
                argumentsDelta,
            };
            continue;
        }
        const trackedState = patchIndexes.get(chunk.index);
        if (chunk.type === 'block-end' && trackedState !== undefined && !isApplyPatchEnd(chunk)) {
            patchIndexes.delete(chunk.index);
            yield rejectedApplyPatchEnd(chunk.index, trackedState.id);
            continue;
        }
        if (isApplyPatchEnd(chunk)) {
            const state = trackedState;
            let rejected = state?.rejected ?? false;
            let finalPatch;
            const finalId = typeof chunk.block.id === 'string' && chunk.block.id.length > 0
                ? chunk.block.id
                : undefined;
            if (finalId === undefined)
                rejected = true;
            if (state !== undefined && finalId !== state.id)
                rejected = true;
            if (!rejected && typeof chunk.block.arguments === 'string') {
                try {
                    finalPatch = unwrapApplyPatchArguments(chunk.block.arguments);
                    if (state?.sawArgumentBytes) {
                        const streamedPatch = state.mode === 'raw' || state.closed
                            ? state.emitted
                            : unwrapApplyPatchArguments(state.buffer);
                        rejected = streamedPatch !== finalPatch;
                    }
                }
                catch (error) {
                    if (!(error instanceof PatchError))
                        throw error;
                    rejected = true;
                }
            }
            else {
                rejected = true;
            }
            patchIndexes.delete(chunk.index);
            if (rejected || finalPatch === undefined) {
                yield rejectedApplyPatchEnd(chunk.index, state?.id ?? finalId);
                continue;
            }
            yield {
                ...chunk,
                block: {
                    ...chunk.block,
                    arguments: finalPatch,
                },
            };
            continue;
        }
        yield value;
    }
    for (const [index, state] of patchIndexes) {
        yield rejectedApplyPatchEnd(index, state.id);
    }
}
/** Add pi-ai grammar metadata only to this plugin's single-string tool schema. */
export function withApplyPatchGrammar(context, grammar) {
    const tools = context.tools;
    if (!Array.isArray(tools))
        return context;
    let changed = false;
    const bridgedTools = tools.map((tool) => {
        if (tool.name !== APPLY_PATCH_TOOL_NAME || !isPatchStringSchema(tool.parameters))
            return tool;
        changed = true;
        return {
            ...tool,
            constrainedSampling: {
                type: 'grammar',
                variants: { openai_lark: grammar },
            },
        };
    });
    return changed ? { ...context, tools: bridgedTools } : context;
}
function grammarCapableModel(model) {
    if (typeof model !== 'object' || model === null || Array.isArray(model))
        return model;
    const compat = typeof model.compat === 'object'
        && model.compat !== null
        && !Array.isArray(model.compat)
        ? model.compat
        : {};
    return {
        ...model,
        compat: {
            ...compat,
            supportsOpenAIGrammarTools: true,
        },
    };
}
/** Wrap one pi-ai snapshot without mutating its immutable Models collection. */
export function bridgeSnapshot(snapshot, grammar) {
    const models = snapshot.models;
    const bridgedModels = new Proxy(models, {
        get(target, property) {
            if (property === 'streamSimple') {
                return (model, context, options) => {
                    const bridgedContext = withApplyPatchGrammar(context, grammar);
                    const bridgedModel = bridgedContext === context ? model : grammarCapableModel(model);
                    const stream = target.streamSimple(bridgedModel, bridgedContext, options);
                    return bridgedContext === context ? stream : bridgeApplyPatchStartEvents(stream);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return { ...snapshot, models: bridgedModels };
}
async function loadGrammar() {
    const grammarUrl = new URL('../third_party/codex/apply_patch.lark', import.meta.url);
    const grammar = await readFile(grammarUrl, 'utf8');
    if (grammar.trim().length === 0) {
        throw new PatchError('dsh-smarter-edit: bundled freeform grammar is empty', 'PATCH_UNSUPPORTED');
    }
    return grammar;
}
/**
 * Upgrade pi-ai's apply_patch function schema to an OpenAI custom grammar tool.
 * DSH strips constrained-sampling metadata before pi-ai, so the bridge wraps
 * the adapter's request-frozen Models snapshot shared by alpha and rc builds.
 */
export async function installPiAiFreeformBridge() {
    const grammar = await loadGrammar();
    const imported = await import('@deepseek-ai/dsh-llm-pi-ai');
    const prototype = imported.PiAiAdapter.prototype;
    const existing = globalBridge[STATE_KEY];
    if (existing !== undefined) {
        if (existing.prototype !== prototype) {
            throw new PatchError('dsh-smarter-edit: conflicting pi-ai adapter prototype is already bridged', 'PATCH_UNSUPPORTED');
        }
        existing.references += 1;
        return () => releaseBridge(existing);
    }
    const original = prototype.current;
    if (typeof original !== 'function') {
        throw new PatchError('dsh-smarter-edit: this dsh-llm-pi-ai version has no compatible current snapshot boundary', 'PATCH_UNSUPPORTED');
    }
    const bridgedSnapshots = new WeakMap();
    const wrapper = function () {
        const snapshot = original.call(this);
        if (typeof snapshot !== 'object' || snapshot === null || typeof snapshot.models !== 'object') {
            throw new PatchError('dsh-smarter-edit: pi-ai adapter returned an incompatible snapshot', 'PATCH_UNSUPPORTED');
        }
        const cached = bridgedSnapshots.get(snapshot);
        if (cached !== undefined)
            return cached;
        const bridged = bridgeSnapshot(snapshot, grammar);
        bridgedSnapshots.set(snapshot, bridged);
        return bridged;
    };
    Object.defineProperty(prototype, 'current', {
        configurable: true,
        writable: true,
        value: wrapper,
    });
    const originalStream = prototype.stream;
    if (typeof originalStream !== 'function') {
        Object.defineProperty(prototype, 'current', {
            configurable: true,
            writable: true,
            value: original,
        });
        throw new PatchError('dsh-smarter-edit: this dsh-llm-pi-ai version has no compatible stream boundary', 'PATCH_UNSUPPORTED');
    }
    const streamWrapper = function (options) {
        noteFreeformRoute(options);
        return originalStream.call(this, rewrapApplyPatchHistory(options));
    };
    Object.defineProperty(prototype, 'stream', {
        configurable: true,
        writable: true,
        value: streamWrapper,
    });
    let originalPrepareCall;
    let prepareCallWrapper;
    if (Object.hasOwn(prototype, 'prepareCall') && typeof prototype.prepareCall === 'function') {
        originalPrepareCall = prototype.prepareCall;
        prepareCallWrapper = async function (...args) {
            noteFreeformRoute({ provider: args[0] });
            const prepared = await originalPrepareCall.apply(this, args);
            if (typeof prepared !== 'object'
                || prepared === null
                || typeof prepared.stream !== 'function') {
                throw new PatchError('dsh-smarter-edit: pi-ai adapter returned an incompatible prepared call', 'PATCH_UNSUPPORTED');
            }
            const preparedStream = prepared.stream;
            return {
                ...prepared,
                stream(options) {
                    return preparedStream(rewrapApplyPatchHistory(options));
                },
            };
        };
        Object.defineProperty(prototype, 'prepareCall', {
            configurable: true,
            writable: true,
            value: prepareCallWrapper,
        });
    }
    const state = {
        prototype,
        original,
        wrapper,
        ...(originalPrepareCall === undefined ? {} : {
            originalPrepareCall,
            prepareCallWrapper: prepareCallWrapper,
        }),
        originalStream,
        streamWrapper,
        references: 1,
    };
    globalBridge[STATE_KEY] = state;
    return () => releaseBridge(state);
}
function releaseBridge(state) {
    if (globalBridge[STATE_KEY] !== state)
        return;
    state.references -= 1;
    if (state.references > 0)
        return;
    if (state.prototype.current === state.wrapper) {
        Object.defineProperty(state.prototype, 'current', {
            configurable: true,
            writable: true,
            value: state.original,
        });
    }
    if (state.prototype.stream === state.streamWrapper) {
        Object.defineProperty(state.prototype, 'stream', {
            configurable: true,
            writable: true,
            value: state.originalStream,
        });
    }
    if (state.prototype.prepareCall === state.prepareCallWrapper && state.originalPrepareCall !== undefined) {
        Object.defineProperty(state.prototype, 'prepareCall', {
            configurable: true,
            writable: true,
            value: state.originalPrepareCall,
        });
    }
    delete globalBridge[STATE_KEY];
}
