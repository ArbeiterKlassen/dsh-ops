#!/usr/bin/env node
/** Local-only benchmark lane. This file is deliberately not imported by verify. */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, surfaceAccounting, writeReports } from './lib/measure.mjs'

if (process.env.GITHUB_ACTIONS === 'true' || process.env.GITHUB_ACTIONS === '1') {
  console.error('dsh-ops benchmark: refusing to run in GitHub Actions; this lane is local-only')
  process.exit(2)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (value.startsWith('--')) args.set(value.slice(2), process.argv[index + 1]?.startsWith('--') ? true : process.argv[++index])
}
const number = (name, fallback, minimum = 1) => Math.max(minimum, Number(args.get(name) ?? fallback) || fallback)
const iterations = number('iterations', 5)
const concurrency = number('concurrency', 4)
const outputDir = path.resolve(String(args.get('output') ?? path.join(root, '.tmp-bench')))
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-bench-home-'))
process.env.DSH_HOME = home

const fixtureRoot = path.join(root, 'bench', 'fixtures')
const workspace = mkdtempSync(path.join(home, 'workspace-'))
const sample = path.join(workspace, 'sample.txt')
const large = path.join(workspace, 'large.txt')
writeFileSync(sample, readFileSync(path.join(fixtureRoot, 'sample.txt')))
writeFileSync(large, readFileSync(path.join(fixtureRoot, 'large.txt')))

const scenarios = []
const schemaAccounting = []
const limitations = [
  'Process startup measurements launch the one-shot native worker for every sample; warm means the OS/process environment is warmed, not a persistent worker protocol.',
  'Host/tool measurements use the real Cordis, dsh-tools, sandbox and subprocess services when installed; no host result is synthesized when an API or runtime is unavailable.',
  'Windows ACL restoration and Desktop GUI behavior are not exercised by this command; use the existing permission and Desktop acceptance suites for those dimensions.',
  'Token counts are estimates using bytes divided by four, not tokenizer output. Hashes and byte counts are the comparison contract.',
]

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { return undefined }
}
function skip(id, surface, reason) { scenarios.push({ id, surface, status: 'skipped', reason }) }
async function scenario(id, surface, body) {
  try {
    const result = await body()
    scenarios.push({ id, surface, status: 'passed', ...result })
  } catch (error) {
    scenarios.push({ id, surface, status: 'failed', reason: String(error?.message ?? error), error: error?.stack })
  }
}

let workerPath
let workerVersion
try {
  const { resolveWorker } = await import('../lib/ptc/runtime.js')
  workerPath = resolveWorker({}, { env: process.env })
  workerVersion = execFileSync(workerPath, ['--version'], { encoding: 'utf8' }).trim()
} catch (error) {
  skip('native-worker', 'native worker', `unavailable: ${String(error?.message ?? error)}`)
}

function nativeRequest(tool, requestArgs, { readOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(workerPath, [], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr.slice(0, 300)}`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`worker returned invalid JSON: ${stdout.slice(0, 300)}`)) }
    })
    child.stdin.end(JSON.stringify({
      root: workspace, scope: 'local-benchmark', tool, args: requestArgs,
      read_only: readOnly, deny_roots: [], deny_credential_names: false,
    }))
  })
}

if (workerPath) {
  await scenario('native-cold-start', 'native worker', async () => ({
    measurements: [await measure('cold process launch', iterations, () => nativeRequest('inspect_local_file', { path: sample, offset: 1, limit: 2 }))],
  }))
  await nativeRequest('inspect_local_file', { path: sample, offset: 1, limit: 1 })
  await scenario('native-warm-start', 'native worker', async () => ({
    measurements: [await measure('warm process launch', iterations, () => nativeRequest('inspect_local_file', { path: sample, offset: 1, limit: 2 }))],
  }))
  await scenario('native-concurrency', 'native worker', async () => ({
    measurements: [await measure(`${concurrency} concurrent requests`, iterations, async () => {
      const started = process.hrtime.bigint()
      const results = await Promise.all(Array.from({ length: concurrency }, () => nativeRequest('grep', { path: workspace, pattern: 'benchmark', glob: ['*.txt'], outputMode: 'count' })))
      return { ms: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3)), bytes: JSON.stringify(results).length }
    })],
  }))
  await scenario('native-large-output', 'native worker', async () => ({
    measurements: [await measure('large bounded inspect', iterations, async () => {
      const value = await nativeRequest('inspect_local_file', { path: large, offset: 1, limit: 10000 })
      return { bytes: JSON.stringify(value).length }
    })],
  }))
  await scenario('native-permission-sandbox', 'native worker', async () => ({
    measurements: [await measure('read-only mutation refusal', iterations, async () => {
      const value = await nativeRequest('replace', { path: sample, pattern: 'never-present', replacement: 'changed' }, { readOnly: true })
      if (value?.error?.code !== 'POLICY_DENIED') throw new Error(`expected POLICY_DENIED, got ${value?.error?.code ?? value?.status}`)
      return { bytes: JSON.stringify(value).length }
    })],
  }))
}

let host
try {
  const [{ bootHost, mountPlugin, callTool, renderSections, shutdown }, Sandbox, Subprocess] = await Promise.all([
    import('../test/lib/host.mjs'), import('@deepseek-ai/dsh-sandbox-local'), import('@deepseek-ai/dsh-subprocess-local'),
  ])
  host = { bootHost, mountPlugin, callTool, renderSections, shutdown, Sandbox: Sandbox.default, Subprocess: Subprocess.default }
} catch (error) {
  skip('plugin-wrapper', 'plugin wrapper / host', `host APIs unavailable: ${String(error?.message ?? error)}`)
}

if (host && workerPath) {
  async function startHost() {
    const { ctx, tools, prompt } = await host.bootHost()
    await ctx.plugin(host.Subprocess)
    await ctx.plugin(host.Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    const mounted = await host.mountPlugin({ ctx, config: { toolCallTimeoutMs: 10000 }, expectTools: 4 })
    return { ctx, tools, prompt, fiber: mounted.fiber }
  }
  let mounted
  try {
    mounted = await startHost()
    const schemas = mounted.tools.schemas?.() ?? []
    let sections = []
    try { sections = (await host.renderSections(mounted.ctx)).entries ? [...(await host.renderSections(mounted.ctx)).entries()].map(([name, text]) => ({ name, text })) : [] } catch (error) { limitations.push(`Host prompt assembly was unavailable: ${error.message}`) }
    schemaAccounting.push({ surface: 'plugin wrapper / host', ...surfaceAccounting({ schemas, sections }) })
  } catch (error) {
    skip('plugin-wrapper', 'plugin wrapper / host', `mount unavailable: ${String(error?.message ?? error)}`)
  } finally {
    if (mounted) await host.shutdown(mounted.ctx)
  }
  await scenario('plugin-cold-start', 'plugin wrapper / host', async () => ({
    measurements: [await measure('Cordis host + plugin mount', Math.min(iterations, 3), async () => {
      const started = process.hrtime.bigint()
      const value = await startHost()
      await host.shutdown(value.ctx)
      return { ms: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3)) }
    })],
  }))
  mounted = await startHost()
  const agent = { id: 'benchmark-agent', session: { id: 'benchmark-session', mode: 'workspace-write', header: { cwd: workspace } } }
  await scenario('plugin-tool-surface', 'plugin wrapper / host', async () => ({
    measurements: [await measure('ops_glob tool call', iterations, async () => {
      const value = await host.callTool(mounted.ctx, 'ops_glob', { path: workspace, pattern: ['*.txt'], outputMode: 'paths' }, undefined, agent)
      return { bytes: JSON.stringify(value.value).length }
    })],
  }))
  await scenario('plugin-large-output', 'plugin wrapper / host', async () => ({
    measurements: [await measure('ops_inspect_local_file large bounded output', iterations, async () => {
      const value = await host.callTool(mounted.ctx, 'ops_inspect_local_file', { path: large, offset: 1, limit: 10000 }, undefined, agent)
      return { bytes: JSON.stringify(value.value).length }
    })],
  }))
  await scenario('plugin-permission-sandbox', 'plugin wrapper / host', async () => ({
    measurements: [await measure('ops_replace read-only refusal', iterations, async () => {
      const readonly = { ...agent, session: { ...agent.session, mode: 'read-only' } }
      const value = await host.callTool(mounted.ctx, 'ops_replace', { path: sample, pattern: 'never-present', replacement: 'changed' }, undefined, readonly)
      if (value.value?.error?.code !== 'POLICY_DENIED') throw new Error(`expected POLICY_DENIED, got ${value.value?.error?.code ?? value.value?.status}`)
      return { bytes: JSON.stringify(value.value).length }
    })],
  }))
  await host.shutdown(mounted.ctx)
} else if (host) {
  skip('plugin-wrapper', 'plugin wrapper / host', 'native worker unavailable; real plugin file surface cannot mount without its worker')
}

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform, arch: process.arch, node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length,
    memoryBytes: os.totalmem(), gitCommit: gitCommit(), worker: workerVersion,
    githubActions: process.env.GITHUB_ACTIONS ?? 'unset',
  },
  parameters: { iterations, concurrency },
  scenarios,
  schemaAccounting,
  limitations,
}
const files = writeReports(report, { jsonFile: path.join(outputDir, 'report.json'), markdownFile: path.join(outputDir, 'report.md') })
console.log(JSON.stringify({ output: files, passed: scenarios.filter(s => s.status === 'passed').length, skipped: scenarios.filter(s => s.status === 'skipped').length, failed: scenarios.filter(s => s.status === 'failed').length }, null, 2))
rmSync(home, { recursive: true, force: true })
if (scenarios.some(scenario => scenario.status === 'failed')) process.exitCode = 1
