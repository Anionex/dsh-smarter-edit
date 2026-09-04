// Ported from OpenAI Codex apply-patch (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { rustTrim, rustTrimEnd } from './codex-whitespace.js';
import { PatchError } from './errors.js';
import { SourceFile } from './source-file.js';
const UNICODE_ASCII = new Map([
    ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'], ['\u2015', '-'], ['\u2212', '-'],
    ['\u2018', "'"], ['\u2019', "'"], ['\u201a', "'"], ['\u201b', "'"],
    ['\u201c', '"'], ['\u201d', '"'], ['\u201e', '"'], ['\u201f', '"'],
    ['\u00a0', ' '], ['\u2002', ' '], ['\u2003', ' '], ['\u2004', ' '], ['\u2005', ' '], ['\u2006', ' '],
    ['\u2007', ' '], ['\u2008', ' '], ['\u2009', ' '], ['\u200a', ' '], ['\u202f', ' '], ['\u205f', ' '], ['\u3000', ' '],
]);
function normalizeUnicode(line) {
    return [...rustTrim(line)].map(character => UNICODE_ASCII.get(character) ?? character).join('');
}
function findWith(lines, pattern, start, compare) {
    const last = lines.length - pattern.length;
    for (let index = start; index <= last; index += 1) {
        if (pattern.every((line, offset) => compare(lines[index + offset], line)))
            return index;
    }
    return undefined;
}
/** Direct port of Codex apply-patch's seek_sequence in PreserveLineEndings mode. */
export function seekSequence(lines, pattern, start, atEnd) {
    if (pattern.length === 0)
        return start;
    if (pattern.length > lines.length)
        return undefined;
    const searchStart = atEnd ? Math.max(start, lines.length - pattern.length) : start;
    return findWith(lines, pattern, searchStart, (left, right) => left === right)
        ?? findWith(lines, pattern, searchStart, (left, right) => rustTrimEnd(left) === rustTrimEnd(right))
        ?? findWith(lines, pattern, searchStart, (left, right) => rustTrim(left) === rustTrim(right))
        ?? findWith(lines, pattern, searchStart, (left, right) => normalizeUnicode(left) === normalizeUnicode(right));
}
/** Direct port of Codex file_update::compute_replacements. */
function computeReplacements(lines, path, chunks) {
    const replacements = [];
    let lineIndex = 0;
    for (const chunk of chunks) {
        if (chunk.changeContext !== undefined) {
            const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex, false);
            if (contextIndex === undefined) {
                throw new PatchError(`apply_patch: Failed to find context '${chunk.changeContext}' in ${path}`, 'PATCH_CONTEXT_NOT_FOUND', { line: chunk.line });
            }
            lineIndex = contextIndex + 1;
        }
        if (chunk.oldLines.length === 0) {
            replacements.push([lines.length, 0, chunk.newLines]);
            continue;
        }
        let pattern = chunk.oldLines;
        let newLines = chunk.newLines;
        let matchIndex = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
        if (matchIndex === undefined && pattern.at(-1) === '') {
            pattern = pattern.slice(0, -1);
            if (newLines.at(-1) === '')
                newLines = newLines.slice(0, -1);
            matchIndex = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
        }
        if (matchIndex === undefined) {
            throw new PatchError(`apply_patch: Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`, 'PATCH_CONTEXT_NOT_FOUND', { line: chunk.line });
        }
        let oldStart = 0;
        let newStart = 0;
        for (const [oldContext, newContext] of chunk.contextLineIndices) {
            if (oldContext >= pattern.length || newContext >= newLines.length)
                break;
            if (oldStart !== oldContext || newStart !== newContext) {
                replacements.push([
                    matchIndex + oldStart,
                    oldContext - oldStart,
                    newLines.slice(newStart, newContext),
                ]);
            }
            oldStart = oldContext + 1;
            newStart = newContext + 1;
        }
        if (oldStart !== pattern.length || newStart !== newLines.length) {
            replacements.push([
                matchIndex + oldStart,
                pattern.length - oldStart,
                newLines.slice(newStart),
            ]);
        }
        lineIndex = matchIndex + pattern.length;
    }
    replacements.sort((left, right) => left[0] - right[0]);
    return replacements;
}
/** Derive one updated file in memory using Codex PreserveLineEndings semantics. */
export function applyChunks(content, path, chunks) {
    const source = SourceFile.parse(content);
    const replacements = computeReplacements(source.lineTexts(), path, chunks);
    source.applyReplacements(replacements);
    return source.contents();
}
