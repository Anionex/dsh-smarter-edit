// Ported from OpenAI Codex apply-patch (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { rustTrim, rustTrimEnd } from './codex-whitespace.js'
import { PatchError } from './errors.js'
import type { ParsedPatch, PatchOperation, UpdateChunk, UpdateFileOperation } from './types.js'

const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const ADD_FILE = '*** Add File: '
const DELETE_FILE = '*** Delete File: '
const UPDATE_FILE = '*** Update File: '
const MOVE_TO = '*** Move to: '
const END_OF_FILE = '*** End of File'
const CHANGE_CONTEXT = '@@ '
const EMPTY_CHANGE_CONTEXT = '@@'
const ENVIRONMENT_ID = '*** Environment ID:'

type Mode =
  | { kind: 'started' }
  | { kind: 'add'; operation: Extract<PatchOperation, { kind: 'add' }> }
  | { kind: 'delete' }
  | { kind: 'update'; operation: UpdateFileOperation; hunkLine: number }

function invalidPatch(message: string): never {
  throw new PatchError(`apply_patch: invalid patch: ${message}`, 'PATCH_INVALID')
}

function invalidHunk(message: string, line: number): never {
  throw new PatchError(`apply_patch: invalid hunk at line ${line}: ${message}`, 'PATCH_INVALID', { line })
}

function splitPatchLines(input: string): string[] {
  const trimmed = rustTrim(input)
  const original = trimmed.length === 0
    ? []
    : trimmed.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  const first = original[0] === undefined ? undefined : rustTrim(original[0])
  const finalLine = original.at(-1)
  const last = finalLine === undefined ? undefined : rustTrim(finalLine)
  if (first === BEGIN_PATCH && last === END_PATCH) return original

  if (original.length >= 4
    && (original[0] === '<<EOF' || original[0] === "<<'EOF'" || original[0] === '<<"EOF"')
    && original.at(-1)?.endsWith('EOF')) {
    const inner = original.slice(1, -1)
    if (rustTrim(inner[0] as string) === BEGIN_PATCH && rustTrim(inner.at(-1) as string) === END_PATCH) return inner
    if (rustTrim(inner[0] as string) !== BEGIN_PATCH) invalidPatch(`The first line of the patch must be '${BEGIN_PATCH}'`)
    invalidPatch(`The last line of the patch must be '${END_PATCH}'`)
  }

  if (first !== undefined && first !== BEGIN_PATCH) invalidPatch(`The first line of the patch must be '${BEGIN_PATCH}'`)
  invalidPatch(`The last line of the patch must be '${END_PATCH}'`)
}

function newChunk(line: number, changeContext?: string): UpdateChunk {
  return {
    ...(changeContext === undefined ? {} : { changeContext }),
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false,
    line,
  }
}

function currentUpdate(mode: Mode): Extract<Mode, { kind: 'update' }> | undefined {
  return mode.kind === 'update' ? mode : undefined
}

function ensureUpdateHunkIsNotEmpty(mode: Mode, nextLine: string, lineNumber: number): void {
  const update = currentUpdate(mode)
  if (update === undefined) return
  const chunks = update.operation.chunks
  if (chunks.length === 0) {
    invalidHunk(`Update file hunk for path '${update.operation.path}' is empty`, update.hunkLine)
  }
  const last = chunks.at(-1) as UpdateChunk
  if (last.oldLines.length === 0 && last.newLines.length === 0) {
    if (nextLine === END_PATCH) invalidHunk('Update hunk does not contain any lines', lineNumber)
    invalidHunk(
      `Unexpected line found in update hunk: '${nextLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      lineNumber,
    )
  }
}

/** Parse complete input using the same states and leniency as Codex StreamingPatchParser. */
export function parsePatch(input: string): ParsedPatch {
  if (typeof input !== 'string') invalidPatch('input must be a string')
  const lines = splitPatchLines(input)
  const operations: PatchOperation[] = []
  let environmentId: string | undefined
  let mode: Mode = { kind: 'started' }

  const startOperation = (trimmed: string, lineNumber: number): boolean => {
    if (trimmed.startsWith(ADD_FILE)) {
      ensureUpdateHunkIsNotEmpty(mode, trimmed, lineNumber)
      const operation: Extract<PatchOperation, { kind: 'add' }> = {
        kind: 'add',
        path: trimmed.slice(ADD_FILE.length),
        content: '',
        line: lineNumber,
      }
      operations.push(operation)
      mode = { kind: 'add', operation }
      return true
    }
    if (trimmed.startsWith(DELETE_FILE)) {
      ensureUpdateHunkIsNotEmpty(mode, trimmed, lineNumber)
      operations.push({ kind: 'delete', path: trimmed.slice(DELETE_FILE.length), line: lineNumber })
      mode = { kind: 'delete' }
      return true
    }
    if (trimmed.startsWith(UPDATE_FILE)) {
      ensureUpdateHunkIsNotEmpty(mode, trimmed, lineNumber)
      const operation: UpdateFileOperation = {
        kind: 'update',
        path: trimmed.slice(UPDATE_FILE.length),
        chunks: [],
        line: lineNumber,
      }
      operations.push(operation)
      mode = { kind: 'update', operation, hunkLine: lineNumber }
      return true
    }
    return false
  }

  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index] as string
    const lineNumber = index + 1

    const activeMode = mode as Mode
    if (activeMode.kind !== 'update') {
      const trimmed = rustTrim(line)
      if (activeMode.kind === 'started' && trimmed.startsWith(ENVIRONMENT_ID)) {
        if (environmentId !== undefined) invalidPatch('apply_patch environment_id cannot be specified more than once')
        environmentId = rustTrim(trimmed.slice(ENVIRONMENT_ID.length))
        if (environmentId.length === 0) invalidPatch('apply_patch environment_id cannot be empty')
        continue
      }
      if (startOperation(trimmed, lineNumber)) continue
      if (activeMode.kind === 'add' && line.startsWith('+')) {
        activeMode.operation.content += `${line.slice(1)}\n`
        continue
      }
      invalidHunk(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '${ADD_FILE}{path}', '${DELETE_FILE}{path}', '${UPDATE_FILE}{path}'`,
        lineNumber,
      )
    }

    const updateLine = rustTrimEnd(line)
    if (startOperation(updateLine, lineNumber)) continue
    const updateMode = activeMode
    const chunks = updateMode.operation.chunks
    const last = chunks.at(-1)

    if (last?.isEndOfFile) {
      if (updateLine.length === 0) continue
      if (updateLine !== EMPTY_CHANGE_CONTEXT && !updateLine.startsWith(CHANGE_CONTEXT)) {
        invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNumber)
      }
    }

    if (chunks.length === 0 && updateMode.operation.moveTo === undefined && updateLine.startsWith(MOVE_TO)) {
      updateMode.operation.moveTo = updateLine.slice(MOVE_TO.length)
      continue
    }

    if ((updateLine === EMPTY_CHANGE_CONTEXT || updateLine.startsWith(CHANGE_CONTEXT))
      && last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
      invalidHunk(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNumber,
      )
    }

    if (updateLine === EMPTY_CHANGE_CONTEXT) {
      chunks.push(newChunk(lineNumber))
      continue
    }
    if (updateLine.startsWith(CHANGE_CONTEXT)) {
      chunks.push(newChunk(lineNumber, updateLine.slice(CHANGE_CONTEXT.length)))
      continue
    }
    if (updateLine === END_OF_FILE) {
      if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
        invalidHunk('Update hunk does not contain any lines', lineNumber)
      }
      if (last !== undefined) last.isEndOfFile = true
      continue
    }

    if (line.length === 0 || line.startsWith(' ')) {
      const chunk = chunks.at(-1) ?? newChunk(lineNumber)
      if (chunks.length === 0) chunks.push(chunk)
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length])
      const context = line.length === 0 ? '' : line.slice(1)
      chunk.oldLines.push(context)
      chunk.newLines.push(context)
      continue
    }
    if (line.startsWith('+')) {
      const chunk = chunks.at(-1) ?? newChunk(lineNumber)
      if (chunks.length === 0) chunks.push(chunk)
      chunk.newLines.push(line.slice(1))
      continue
    }
    if (line.startsWith('-')) {
      const chunk = chunks.at(-1) ?? newChunk(lineNumber)
      if (chunks.length === 0) chunks.push(chunk)
      chunk.oldLines.push(line.slice(1))
      continue
    }

    if (last !== undefined && (last.oldLines.length > 0 || last.newLines.length > 0)) {
      invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNumber)
    }
    invalidHunk(
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      lineNumber,
    )
  }

  ensureUpdateHunkIsNotEmpty(mode, END_PATCH, lines.length)
  return {
    operations,
    normalizedPatch: lines.join('\n'),
    ...(environmentId === undefined ? {} : { environmentId }),
  }
}
