import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const compiledPath = join(root, '.client-build', 'index.js')
const outputPath = join(root, 'lib', 'client.js')
const source = await readFile(compiledPath, 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({ id: "@anionex/dsh-apply-patch", factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
  source,
  'return module.exports; } });',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped)
await rm(join(root, '.client-build'), { recursive: true, force: true })
