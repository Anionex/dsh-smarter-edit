import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChunks, parsePatch, seekSequence } from '../lib/engine.js'

test('parses add, delete, update, move, and multiple chunks', () => {
  const parsed = parsePatch(`*** Begin Patch
*** Add File: src/new.ts
+export const value = 1
*** Delete File: src/old.ts
*** Update File: src/app.ts
*** Move to: src/main.ts
@@ function first()
-old one
+new one
@@
-old two
+new two
*** End Patch`)
  assert.equal(parsed.operations.length, 3)
  assert.deepEqual(parsed.operations.map(operation => operation.kind), ['add', 'delete', 'update'])
  assert.equal(parsed.operations[0].content, 'export const value = 1\n')
  assert.equal(parsed.operations[2].moveTo, 'src/main.ts')
  assert.equal(parsed.operations[2].chunks.length, 2)
})

test('rejects malformed envelopes and hunks with line numbers', () => {
  assert.throws(() => parsePatch('bad'), /first line/u)
  assert.throws(() => parsePatch(`*** Begin Patch
*** Add File: x
not prefixed
*** End Patch`), /line 3/u)
  const contextOnly = parsePatch(`*** Begin Patch
*** Update File: x
@@
 context only
*** End Patch`)
  assert.equal(contextOnly.operations.length, 1)
  assert.deepEqual(parsePatch(`*** Begin Patch
*** End Patch`).operations, [])
})

test('applies ordered chunks and preserves CRLF on replaced and untouched lines', () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: app.txt
@@ alpha
-beta
+BETA
@@
-gamma
+GAMMA
*** End Patch`).operations[0]
  assert.equal(operation.kind, 'update')
  const result = applyChunks('alpha\r\nbeta\r\ngamma\r\n', 'app.txt', operation.chunks)
  assert.equal(result, 'alpha\r\nBETA\r\nGAMMA\r\n')
})

test('matches Codex tolerance levels and end-of-file anchoring', () => {
  assert.equal(seekSequence(['  alpha  ', 'beta\t'], ['alpha', 'beta'], 0, false), 0)
  assert.equal(seekSequence(['before', 'smart — quote “x”'], ['smart - quote "x"'], 0, false), 1)
  assert.equal(seekSequence(['tail', 'same', 'tail', 'same'], ['tail', 'same'], 0, true), 2)
})

test('uses Rust whitespace and NUL semantics exactly like Codex', () => {
  assert.equal(seekSequence(['\u0085foo\u0085'], ['foo'], 0, false), 0)
  assert.equal(seekSequence(['\ufefffoo\ufeff'], ['foo'], 0, false), undefined)

  const padded = parsePatch(`\u0085*** Begin Patch\u0085
*** Add File: x
+a\0b
\u0085*** End Patch\u0085`)
  assert.equal(padded.operations[0].kind, 'add')
  assert.equal(padded.operations[0].content, 'a\0b\n')
  assert.throws(() => parsePatch(`\ufeff*** Begin Patch\ufeff
*** Add File: x
+x
*** End Patch`), /first line/u)
})

test('treats marker-shaped content lines as context, not control syntax', () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: app.txt
 @@
 *** Add File: literal.txt
+tail
*** End Patch`).operations[0]
  assert.equal(operation.kind, 'update')
  assert.equal(applyChunks('@@\n*** Add File: literal.txt\n', 'app.txt', operation.chunks), '@@\n*** Add File: literal.txt\ntail\n')
})

test('preserves mixed context endings and applies Codex trailing-newline behavior', () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: app.txt
@@
 first
-second
+SECOND
*** End Patch`).operations[0]
  assert.equal(operation.kind, 'update')
  assert.equal(applyChunks('first\r\nsecond\nlast', 'app.txt', operation.chunks), 'first\r\nSECOND\r\nlast\r\n')
})

test('pure additions append and add the separator needed after an unterminated line', () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: app.txt
@@
+second
*** End Patch`).operations[0]
  assert.equal(operation.kind, 'update')
  assert.equal(applyChunks('first', 'app.txt', operation.chunks), 'first\nsecond\n')
})

test('sorts a pure addition and a later earlier-file hunk like Codex', () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: app.txt
@@
+tail
@@
-first
+FIRST
*** End Patch`).operations[0]
  assert.equal(operation.kind, 'update')
  assert.equal(applyChunks('first\n', 'app.txt', operation.chunks), 'FIRST\ntail\n')
})

test('accepts Codex marker whitespace and treats naked update blank lines as context', () => {
  const operation = parsePatch(`  *** Begin Patch
  *** Update File: app.txt
@@
 first

-last
+LAST
 *** End Patch  `).operations[0]
  assert.equal(operation.kind, 'update')
  assert.equal(applyChunks('first\n\nlast\n', 'app.txt', operation.chunks), 'first\n\nLAST\n')
})
