import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  DiffBlock,
  DisclosureRow,
  IconEditOutline16,
  IconInspectOutline12,
  StateDot,
  type DiffBlockLabels,
  type DiffHunk,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'

type ApplyPatchRowProps = ToolCallViewProps & PropsLocale<'conversation'>
type RowState = 'running' | 'ok' | 'error' | 'stopped'

const CSS = `
.dsh-apply-patch-row{display:flex;flex-direction:column;width:100%;min-width:0}
.dsh-apply-patch-row__header{overflow:hidden}
.dsh-apply-patch-row__title{font-weight:400}
.dsh-apply-patch-row__sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}
.dsh-apply-patch-row__summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}
button.dsh-apply-patch-row__summary{text-align:left;padding:0;border:0;background:none;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;text-decoration-color:var(--dsw-alias-label-tertiary);text-underline-offset:3px;cursor:pointer}
button.dsh-apply-patch-row__summary:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}
.dsh-apply-patch-row__stat{flex:none;margin-left:10px;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);color:var(--dsw-alias-label-caption)}
.dsh-apply-patch-row__body{display:flex;flex-direction:column}
.dsh-apply-patch-row__diff{margin:4px 0 4px 4px}
.dsh-apply-patch-row__output{margin:4px 0 4px 4px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;font:var(--dsw-font-markdown-code-block-small)}
.dsh-apply-patch-row__output[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.dsh-apply-patch-row__inspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;opacity:0;transition:opacity 100ms ease}
.dsh-apply-patch-row:hover .dsh-apply-patch-row__inspect,.dsh-apply-patch-row__inspect:focus-visible{opacity:1}
.dsh-apply-patch-row__inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsh-apply-patch-row__sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`

function installStyles(): () => void {
  const id = '@anionex/dsh-apply-patch/client'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = '@anionex/dsh-apply-patch'
  style.dataset.pluginCss = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

function narrowDiffs(meta: unknown): DiffHunk[] | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const value = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(value) || value.length === 0) return null
  const diffs: DiffHunk[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const { path, oldText, newText } = item as Record<string, unknown>
    if (
      typeof path !== 'string'
      || (oldText !== null && typeof oldText !== 'string')
      || typeof newText !== 'string'
    ) return null
    diffs.push({ path, oldText, newText })
  }
  return diffs
}

function contentLineCount(value: string): number {
  if (value === '') return 0
  const lines = value.endsWith('\n') ? value.slice(0, -1) : value
  return lines.split('\n').length
}

/** Alpha.1-compatible equivalent of the later exported DSH diffTotals helper. */
function diffTotals(diffs: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    added += contentLineCount(diff.newText)
    if (diff.oldText !== null) removed += contentLineCount(diff.oldText)
  }
  return { added, removed }
}

function patchPaths(raw: string): string[] {
  const paths: string[] = []
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line)
      ?? /^\*\*\* Move to: (.+)$/u.exec(line)
    if (match?.[1] !== undefined && !paths.includes(match[1])) paths.push(match[1])
  }
  return paths
}

function resultText(block: ApplyPatchRowProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts = block.content.map(part => part.type === 'text' ? part.text : JSON.stringify(part, null, 2))
  if (parts.length === 0 && block.error !== undefined) return `${block.error.name}: ${block.error.code}`
  return parts.join('\n') || null
}

function rowState(block: ApplyPatchRowProps['block']): RowState {
  if (!('kind' in block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError ? 'error' : 'ok'
}

function stateLeading(state: RowState): ReactNode {
  if (state === 'error') return <StateDot state="error" />
  if (state === 'stopped') return <StateDot state="warning" />
  if (state === 'running') return <StateDot state="ongoing" />
  return <IconEditOutline16 size={14} />
}

function diffLabels(t: ApplyPatchRowProps['t']): DiffBlockLabels {
  return {
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('diff.collapseAria'),
    expandAria: count => t('diff.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('diff.expandRest', { count }),
    files: count => t(count === 1 ? 'diff.files.one' : 'diff.files.other', { count }),
  }
}

export function ApplyPatchRow({
  callId,
  block,
  openFile,
  inspect,
  t,
}: ApplyPatchRowProps) {
  const [expanded, setExpanded] = useState(false)
  const done = 'kind' in block
  const call = done ? block.call : block
  const raw = call?.argsRaw ?? ''
  const state = rowState(block)
  const diffs = done && !block.isError ? narrowDiffs(block.meta) : null
  const output = resultText(block)
  const paths = diffs === null
    ? patchPaths(raw)
    : [...new Set(diffs.map(diff => diff.path))]
  const summary = paths.length === 1
    ? paths[0] as string
    : paths.length > 1
      ? t('diff.files.other', { count: paths.length })
      : callId
  const expandable = diffs !== null || output !== null
  const open = expanded && expandable
  const totals = useMemo(() => diffs === null ? null : diffTotals(diffs), [diffs])
  const labels = useMemo(() => diffLabels(t), [t])
  const status = state === 'running' ? t('row.running')
    : state === 'error' ? t('row.failed')
      : state === 'stopped' ? t('row.stopped') : null
  const openOnlyPath = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (paths[0] !== undefined) openFile(paths[0])
  }

  return (
    <div className="dsh-apply-patch-row" data-tool="apply_patch" data-state={state}>
      {status !== null && <span className="dsh-apply-patch-row__sr">{status}</span>}
      <DisclosureRow
        icon={stateLeading(state)}
        title="Apply patch"
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        rowClassName="dsh-apply-patch-row__header"
        titleClassName="dsh-apply-patch-row__title"
        collapsedContent={(
          <>
            <span className="dsh-apply-patch-row__sep" aria-hidden />
            {paths.length === 1 && state !== 'error' ? (
              <button type="button" className="dsh-apply-patch-row__summary" onClick={openOnlyPath}>
                {summary}
              </button>
            ) : (
              <span className="dsh-apply-patch-row__summary">{summary}</span>
            )}
            {totals !== null && (
              <span className="dsh-apply-patch-row__stat">+{totals.added} -{totals.removed}</span>
            )}
          </>
        )}
      >
        <div className="dsh-apply-patch-row__body">
          {diffs !== null
            ? <DiffBlock diffs={diffs} labels={labels} maxLines={8} className="dsh-apply-patch-row__diff" />
            : output !== null && (
              <div className="dsh-apply-patch-row__output" data-error={state === 'error'}>
                {output}
              </div>
            )}
          {inspect !== undefined && (
            <button type="button" className="dsh-apply-patch-row__inspect" onClick={inspect}>
              <IconInspectOutline12 />
              {t('row.inspect')}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.effect(installStyles, 'dsh-apply-patch: styles')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'apply_patch',
    locale: 'conversation',
  }, ApplyPatchRow))
}
