import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { defineTool, ToolArgsError, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installPiAiFreeformBridge, unwrapApplyPatchStream } from './freeform-bridge.js'
import { runApplyPatch } from './host.js'
import { parsePatch } from './parser.js'

export const name = '@anionex/dsh-apply-patch'
export const inject = ['tools', 'fs', 'llm', 'systemPrompt']

export interface Config {
  /** Remove the native edit schema and guidance while this plugin is active. */
  replaceNativeEdit?: boolean
}

export const Config: z<Config> = z.object({
  replaceNativeEdit: z.boolean().default(true),
})

type ResolvedConfig = Required<Config>

const TOOL_DESCRIPTION = 'Create, update, move, and delete files by applying a patch.'

const TOOL_GUIDANCE = `Use apply_patch for file edits. Send patch text directly, without JSON or a patch field. Enclose one or more Add File, Update File, Move to, or Delete File operations between *** Begin Patch and *** End Patch.`
const NATIVE_EDIT_TOOL_NAMES = new Set(['edit', 'str_replace_editor'])

/** Accept the restored raw transport and the legacy envelope for compatibility. */
export function applyPatchText(args: unknown): string {
  if (typeof args === 'string') return args
  if (
    typeof args === 'object'
    && args !== null
    && !Array.isArray(args)
    && typeof (args as Record<string, unknown>).patch === 'string'
  ) {
    return (args as { patch: string }).patch
  }
  throw new ToolArgsError(['arguments must be raw apply_patch text'])
}

/** Register the freeform patch tool and its reversible native-edit replacement surface. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig

  const releaseBridge = await installPiAiFreeformBridge()
  ctx.effect(() => releaseBridge, 'dsh-apply-patch pi-ai freeform bridge')
  ctx.on('llm/stream', (_options, next) => unwrapApplyPatchStream(next()))

  ctx.systemPrompt.section({
    name: 'tool:apply-patch',
    // TOOL_EDIT is 1300 in both the alpha.1 constant API and alpha.5 allocator API.
    order: 1300,
    text: TOOL_GUIDANCE,
  })

  if (resolved.replaceNativeEdit) {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return {
        ...assembled,
        tools: assembled.tools.filter(tool => !NATIVE_EDIT_TOOL_NAMES.has(tool.name)),
        sections: assembled.sections
          .filter(section => section.name !== 'tool:edit')
          .map(section => section.name === 'tool:write'
            ? { ...section, text: section.text.replace('prefer edit for targeted changes', 'prefer apply_patch for targeted changes') }
            : section),
      }
    })
  }

  const typedDefinition = defineTool({
    name: 'apply_patch',
    description: TOOL_DESCRIPTION,
    parameters: {
      patch: {
        type: 'string',
        required: true,
        description: 'Patch text containing one or more file operations.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          diff: { type: 'string', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', required: true, enum: ['add', 'delete', 'update', 'move'] },
                path: { type: 'string', required: true },
                from: { type: 'string' },
              },
            },
          },
          diffs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                oldText: {
                  required: true,
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                },
                newText: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.diff.length === 0 ? value.summary : `${value.summary}\n\n${value.diff}`,
      }],
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args, exec) {
      return runApplyPatch(ctx, args.patch, exec)
    },
    presentCall(args) {
      try {
        const parsed = parsePatch(args.patch)
        const locations = parsed.operations.flatMap(operation => operation.kind === 'update' && operation.moveTo !== undefined
          ? [{ path: operation.path }, { path: operation.moveTo }]
          : [{ path: operation.path }])
        return { card: 'generic', title: 'Apply patch', locations }
      } catch {
        return { card: 'generic', title: 'Apply patch' }
      }
    },
    timeoutMs: 30_000,
  })
  const definition: ToolDefinition = {
    ...typedDefinition,
    async execute(args, exec) {
      return runApplyPatch(ctx, applyPatchText(args), exec)
    },
    presentCall(args) {
      try {
        const parsed = parsePatch(applyPatchText(args))
        const locations = parsed.operations.flatMap(operation => operation.kind === 'update' && operation.moveTo !== undefined
          ? [{ path: operation.path }, { path: operation.moveTo }]
          : [{ path: operation.path }])
        return { card: 'generic', title: 'Apply patch', locations }
      } catch {
        return { card: 'generic', title: 'Apply patch' }
      }
    },
  }
  ctx.tools.register(definition)
}

export * from './engine.js'
export * from './errors.js'
export * from './freeform-bridge.js'
export * from './host.js'
export * from './matcher.js'
export * from './parser.js'
export * from './source-file.js'
export * from './types.js'
