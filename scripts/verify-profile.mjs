#!/usr/bin/env node
// Install the packed bundle into an isolated host and exercise a real Agent
// against a deterministic local provider. No external model or credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  dsh: { type: 'string' }, output: { type: 'string' }, 'keep-web': { type: 'boolean', default: false },
  published: { type: 'boolean', default: false },
} })
assert(values.dsh, 'usage: node scripts/verify-profile.mjs --dsh <target-cli> [--output report.json] [--keep-web] [--published]')
const cli = resolve(values.dsh)
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await realpath(await mkdtemp(join(tmpdir(), 'smarter-edit-profile-')))
const workspace = join(root, 'workspace')
const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
  DSH_TELEMETRY_DISABLED: '1', SMARTER_EDIT_FIXTURE_KEY: 'fixture-only',
  npm_config_registry: 'https://registry.npmjs.org', CI: 'true' }
const report = { success: false, steps: [], requests: [] }
const children = new Set()
let web
let providerError
const patch = '*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: before.txt\n@@\n-before\n+after\n*** End Patch'
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions')
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    const tools = request.tools ?? []
    // The host can make separate tool-free title/summary requests.
    if (tools.length === 0) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ id: 'fixture-title', object: 'chat.completion.chunk', created: 1,
        model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Smarter Edit fixture' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    const declaration = tools.find(tool => (tool.custom?.name ?? tool.function?.name) === 'apply_patch')
    assert.equal(declaration?.type, 'custom', 'apply_patch must reach the wire as a custom grammar tool')
    assert.equal(declaration.custom.format.grammar.syntax, 'lark')
    assert(!tools.some(tool => ['edit', 'write', 'str_replace_editor'].includes(tool.function?.name)))
    const previous = request.messages.filter(message => message.role === 'tool')
    report.requests.push({ toolType: declaration.type, toolResults: previous.length })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    if (previous.length === 0) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'custom', custom: { name: 'apply_patch', input: patch } }] })
      chunk({}, 'tool_calls')
    } else {
      assert(previous.some(message => typeof message.content === 'string' && message.content.includes('created.txt')),
        'the second request must carry the real tool result')
      chunk({ role: 'assistant', content: 'Fixture complete.' })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  } catch (error) {
    providerError = error
    res.writeHead(500); res.end(String(error))
  }
})

function launch(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  return { child, output: () => output }
}
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
async function run(command, args, cwd = root, timeout = 180_000) {
  const task = launch(command, args, cwd)
  let expired = false
  const timer = setTimeout(() => { expired = true; stop(task.child) }, timeout)
  try {
    const code = await new Promise((yes, no) => { task.child.on('error', no); task.child.on('close', yes) })
    assert(!expired, `${command} timed out`)
    assert.equal(code, 0, task.output().slice(-6000))
    return task.output()
  } finally { clearTimeout(timer) }
}
async function listen(server) {
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  return server.address().port
}

try {
  await mkdir(workspace)
  await writeFile(join(workspace, 'before.txt'), 'before\n')
  report.dsh = (await run(cli, ['--version'])).trim()
  const port = await listen(provider)
  await mkdir(env.DSH_HOME, { recursive: true })
  const patchPath = join(root, 'fixture.patch.yml')
  await writeFile(patchPath, JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { fixture: { api: 'openai-completions', baseURL: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: 'SMARTER_EDIT_FIXTURE_KEY', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 100000, maxTokens: 1000 }] } } } },
    { id: 'agent-default-model', config: { provider: 'fixture', model: 'fixture' } },
  ]))
  const pack = join(root, 'pack'); await mkdir(pack)
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  report.package = `${pkg.name}@${pkg.version}`
  report.source = values.published ? 'https://registry.npmjs.org' : 'local checkout'
  if (values.published) {
    await run('npm', ['pack', report.package, '--ignore-scripts', '--pack-destination', pack,
      '--registry=https://registry.npmjs.org'], repo)
  } else {
    await run('pnpm', ['pack', '--pack-destination', pack], repo)
  }
  const tarballs = (await readdir(pack)).filter(file => file.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const tarball = join(pack, tarballs[0])
  report.sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  for (const profile of ['headless', 'web']) {
    const dir = join(env.DSH_HOME, 'profiles', profile)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    await run(cli, ['plugin', '--profile', profile, 'add', tarball, '--registry=https://registry.npmjs.org'])
    const installed = await realpath(join(dir, 'node_modules/@anionex/dsh-smarter-edit'))
    assert(installed.startsWith(root), 'tarball must not resolve to the repository')
    assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, pkg.version)
    assert.deepEqual(await readFile(join(installed, 'lib/index.js')), await readFile(join(repo, 'lib/index.js')))
    assert.deepEqual(await readFile(join(installed, 'lib/client.js')), await readFile(join(repo, 'lib/client.js')))
    assert((await run(cli, ['--profile', profile, '--dump-config'])).includes('@anionex/dsh-smarter-edit'))
    report.steps.push(`${profile}: tarball installed and bundle mounted`)
  }
  const result = await run(cli, ['--profile', 'headless', '--patch', patchPath, 'Apply the fixture patch, then finish.'], workspace, 60_000)
  if (providerError) throw providerError
  assert.match(result, /Fixture complete/)
  assert.equal(await readFile(join(workspace, 'before.txt'), 'utf8'), 'after\n')
  assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'created\n')
  assert.equal(report.requests.length, 2)
  report.steps.push('fresh headless Agent: custom grammar request, patch execution, result replay and file contents verified')

  const listener = createServer(); const webPort = await listen(listener)
  await new Promise(yes => listener.close(yes))
  web = launch(cli, ['web', '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', String(webPort)], workspace)
  const base = `http://127.0.0.1:${webPort}`
  const deadline = Date.now() + 45_000
  let html
  let browserURL
  while (Date.now() < deadline) {
    assert.equal(web.child.exitCode, null, web.output().slice(-6000))
    try {
      browserURL = web.output().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
      if (!browserURL) throw new Error('waiting for Web login URL')
      const login = await fetch(browserURL, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const response = await fetch(base, { headers: { cookie }, signal: AbortSignal.timeout(1000) })
      if (response.ok) { html = await response.text(); if (html.includes('@anionex/dsh-smarter-edit')) break }
    } catch {}
    await new Promise(yes => setTimeout(yes, 250))
  }
  assert(html?.includes('@anionex/dsh-smarter-edit'), web.output().slice(-6000))
  report.steps.push('real Web host boots with plugin client in boot entries')
  report.success = true
  if (values['keep-web']) {
    console.log(JSON.stringify({ ready: true, base, root, browserURL }))
    await new Promise(yes => { const timer = setTimeout(yes, 600_000); process.once('SIGTERM', () => { clearTimeout(timer); yes() }) })
  }
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  for (const child of children) stop(child)
  await Promise.all([...children].filter(child => child.exitCode === null && child.signalCode === null)
    .map(child => new Promise(yes => child.once('close', yes))))
  provider.closeAllConnections()
  if (provider.listening) await new Promise(yes => provider.close(yes))
  await rm(root, { recursive: true, force: true })
  report.cleanedUp = true
  if (values.output) await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
