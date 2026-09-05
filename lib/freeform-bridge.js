import { readFile } from 'node:fs/promises';
import { PatchError } from './errors.js';
export const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const STATE_KEY = Symbol.for('@anionex/dsh-smarter-edit/pi-ai-freeform-bridge');
const globalBridge = globalThis;
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
function describePatchArguments(serialized) {
    try {
        const parsed = JSON.parse(serialized);
        if (Array.isArray(parsed))
            return `JSON array with ${parsed.length} item(s)`;
        if (typeof parsed !== 'object' || parsed === null)
            return `JSON ${parsed === null ? 'null' : typeof parsed}`;
        const entries = Object.entries(parsed);
        const fields = entries.slice(0, 4).map(([key, value]) => {
            const valueType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
            const displayedKey = KNOWN_PATCH_ARGUMENT_NAMES.has(key) ? JSON.stringify(key) : '"<unknown>"';
            return `${displayedKey}:${valueType}`;
        });
        return `JSON object with ${entries.length} field(s)${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`;
    }
    catch {
        return `non-JSON text (${serialized.length} chars)`;
    }
}
function hasSingleTopLevelJsonMember(serialized) {
    let depth = 0;
    let inString = false;
    let escaped = false;
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
        else if (character === ',' && depth === 1)
            return false;
    }
    return true;
}
/** Recover raw custom-tool input from pi-ai and provider fallback envelopes. */
export function unwrapApplyPatchArguments(serialized) {
    if (serialized.startsWith('*** Begin Patch'))
        return serialized;
    try {
        const parsed = JSON.parse(serialized);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const [entry] = Object.entries(parsed);
            if (entry !== undefined
                && Object.keys(parsed).length === 1
                && hasSingleTopLevelJsonMember(serialized)
                && typeof entry[1] === 'string'
                && (entry[0] === 'patch'
                    || entry[0] === 'input'
                    || (entry[0] === 'arguments' && entry[1].trimStart().startsWith('*** Begin Patch')))) {
                return entry[1];
            }
        }
    }
    catch {
        // Fall through to the version-mismatch error below.
    }
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
    if (state.mode === 'raw')
        return delta;
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
        && block.name === APPLY_PATCH_TOOL_NAME
        && typeof block.arguments === 'string';
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
        if (chunk.type === 'tool-call-delta'
            && (chunk.name === APPLY_PATCH_TOOL_NAME || patchIndexes.has(chunk.index))) {
            if (typeof chunk.argumentsDelta !== 'string') {
                throw new PatchError('dsh-smarter-edit: pi-ai emitted a non-string patch delta', 'PATCH_UNSUPPORTED');
            }
            const state = patchIndexes.get(chunk.index) ?? { buffer: '', mode: 'unknown', closed: false };
            patchIndexes.set(chunk.index, state);
            yield {
                ...chunk,
                argumentsDelta: decodeApplyPatchDelta(chunk.argumentsDelta, state),
            };
            continue;
        }
        if (isApplyPatchEnd(chunk)) {
            patchIndexes.delete(chunk.index);
            yield {
                ...chunk,
                block: {
                    ...chunk.block,
                    arguments: unwrapApplyPatchArguments(chunk.block.arguments),
                },
            };
            continue;
        }
        yield value;
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
                    return target.streamSimple(bridgedModel, bridgedContext, options);
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
