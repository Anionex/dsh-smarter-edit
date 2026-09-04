window.__ModuleLoader__.load({ id: "@anionex/dsh-smarter-edit", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.ApplyPatchRow = ApplyPatchRow;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const react_1 = require("react");
const CSS = `
.dsh-smarter-edit-row{display:flex;flex-direction:column;width:100%;min-width:0}
.dsh-smarter-edit-row__header{overflow:hidden}
.dsh-smarter-edit-row__title{font-weight:400}
.dsh-smarter-edit-row__sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}
.dsh-smarter-edit-row__summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}
button.dsh-smarter-edit-row__summary{text-align:left;padding:0;border:0;background:none;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;text-decoration-color:var(--dsw-alias-label-tertiary);text-underline-offset:3px;cursor:pointer}
button.dsh-smarter-edit-row__summary:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}
.dsh-smarter-edit-row__stat{flex:none;margin-left:10px;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);color:var(--dsw-alias-label-caption)}
.dsh-smarter-edit-row__body{display:flex;flex-direction:column}
.dsh-smarter-edit-row__diff{margin:4px 0 4px 4px}
.dsh-smarter-edit-row__output{margin:4px 0 4px 4px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;font:var(--dsw-font-markdown-code-block-small)}
.dsh-smarter-edit-row__output[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.dsh-smarter-edit-row__inspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;opacity:0;transition:opacity 100ms ease}
.dsh-smarter-edit-row:hover .dsh-smarter-edit-row__inspect,.dsh-smarter-edit-row__inspect:focus-visible{opacity:1}
.dsh-smarter-edit-row__inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsh-smarter-edit-row__sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;
function installStyles() {
    const id = '@anionex/dsh-smarter-edit/client';
    const existing = document.querySelector(`style[data-plugin-css="${id}"]`);
    if (existing !== null)
        return () => { };
    const style = document.createElement('style');
    style.dataset.plugin = '@anionex/dsh-smarter-edit';
    style.dataset.pluginCss = id;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
}
function narrowDiffs(meta) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta))
        return null;
    const value = meta.diffs;
    if (!Array.isArray(value) || value.length === 0)
        return null;
    const diffs = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            return null;
        const { path, oldText, newText } = item;
        if (typeof path !== 'string'
            || (oldText !== null && typeof oldText !== 'string')
            || typeof newText !== 'string')
            return null;
        diffs.push({ path, oldText, newText });
    }
    return diffs;
}
function contentLineCount(value) {
    if (value === '')
        return 0;
    const lines = value.endsWith('\n') ? value.slice(0, -1) : value;
    return lines.split('\n').length;
}
/** Alpha.1-compatible equivalent of the later exported DSH diffTotals helper. */
function diffTotals(diffs) {
    let added = 0;
    let removed = 0;
    for (const diff of diffs) {
        added += contentLineCount(diff.newText);
        if (diff.oldText !== null)
            removed += contentLineCount(diff.oldText);
    }
    return { added, removed };
}
function patchPaths(raw) {
    const paths = [];
    for (const line of raw.split(/\r?\n/u)) {
        const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line)
            ?? /^\*\*\* Move to: (.+)$/u.exec(line);
        if (match?.[1] !== undefined && !paths.includes(match[1]))
            paths.push(match[1]);
    }
    return paths;
}
function resultText(block) {
    if (!('kind' in block))
        return null;
    const parts = block.content.map(part => part.type === 'text' ? part.text : JSON.stringify(part, null, 2));
    if (parts.length === 0 && block.error !== undefined)
        return `${block.error.name}: ${block.error.code}`;
    return parts.join('\n') || null;
}
function rowState(block) {
    if (!('kind' in block))
        return 'running';
    if (block.error?.code === 'interrupted')
        return 'stopped';
    return block.isError ? 'error' : 'ok';
}
function stateLeading(state) {
    if (state === 'error')
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "error" });
    if (state === 'stopped')
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "warning" });
    if (state === 'running')
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "ongoing" });
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEditOutline16, { size: 14 });
}
function diffLabels(t) {
    return {
        copy: t('copy'),
        copied: t('copied'),
        collapseAria: t('diff.collapseAria'),
        expandAria: count => t('diff.expandAria', { count }),
        collapse: t('collapse'),
        expand: count => t('diff.expandRest', { count }),
        files: count => t(count === 1 ? 'diff.files.one' : 'diff.files.other', { count }),
    };
}
function ApplyPatchRow({ callId, block, openFile, inspect, t, }) {
    const [expanded, setExpanded] = (0, react_1.useState)(false);
    const done = 'kind' in block;
    const call = done ? block.call : block;
    const raw = call?.argsRaw ?? '';
    const state = rowState(block);
    const diffs = done && !block.isError ? narrowDiffs(block.meta) : null;
    const output = resultText(block);
    const paths = diffs === null
        ? patchPaths(raw)
        : [...new Set(diffs.map(diff => diff.path))];
    const summary = paths.length === 1
        ? paths[0]
        : paths.length > 1
            ? t('diff.files.other', { count: paths.length })
            : callId;
    const expandable = diffs !== null || output !== null;
    const open = expanded && expandable;
    const totals = (0, react_1.useMemo)(() => diffs === null ? null : diffTotals(diffs), [diffs]);
    const labels = (0, react_1.useMemo)(() => diffLabels(t), [t]);
    const status = state === 'running' ? t('row.running')
        : state === 'error' ? t('row.failed')
            : state === 'stopped' ? t('row.stopped') : null;
    const openOnlyPath = (event) => {
        event.stopPropagation();
        if (paths[0] !== undefined)
            openFile(paths[0]);
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dsh-smarter-edit-row", "data-tool": "apply_patch", "data-state": state, children: [status !== null && (0, jsx_runtime_1.jsx)("span", { className: "dsh-smarter-edit-row__sr", children: status }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.DisclosureRow, { icon: stateLeading(state), title: "Apply patch", open: open, expandable: expandable, expandOnRowClick: true, keepContentWhenOpen: true, onToggle: () => { setExpanded(value => !value); }, rowClassName: "dsh-smarter-edit-row__header", titleClassName: "dsh-smarter-edit-row__title", collapsedContent: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: "dsh-smarter-edit-row__sep", "aria-hidden": true }), paths.length === 1 && state !== 'error' ? ((0, jsx_runtime_1.jsx)("button", { type: "button", className: "dsh-smarter-edit-row__summary", onClick: openOnlyPath, children: summary })) : ((0, jsx_runtime_1.jsx)("span", { className: "dsh-smarter-edit-row__summary", children: summary })), totals !== null && ((0, jsx_runtime_1.jsxs)("span", { className: "dsh-smarter-edit-row__stat", children: ["+", totals.added, " -", totals.removed] }))] })), children: (0, jsx_runtime_1.jsxs)("div", { className: "dsh-smarter-edit-row__body", children: [diffs !== null
                            ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.DiffBlock, { diffs: diffs, labels: labels, maxLines: 8, className: "dsh-smarter-edit-row__diff" })
                            : output !== null && ((0, jsx_runtime_1.jsx)("div", { className: "dsh-smarter-edit-row__output", "data-error": state === 'error', children: output })), inspect !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: "dsh-smarter-edit-row__inspect", onClick: inspect, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconInspectOutline12, {}), t('row.inspect')] }))] }) })] }));
}
exports.inject = ['slots'];
function apply(ctx) {
    ctx.effect(installStyles, 'dsh-smarter-edit: styles');
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'apply_patch',
        locale: 'conversation',
    }, ApplyPatchRow));
}

return module.exports; } });
