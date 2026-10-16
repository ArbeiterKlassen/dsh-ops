/**
 * Shutdown and provisioning paths that used to fail silently.
 *
 * Adapted from PR #30 (WTStarMark, "fix: 修复 Linux 上原生 worker 完全不可用,并补上四条关停路径").
 * Five of its cases are here; the two that overlap this branch are not, because this branch already
 * reports them differently and its own suites cover the difference:
 *
 * - #30 treats a directory `fsync` that returns `EBADF` on Linux as "this handle cannot sync on this
 *   platform" and stops reporting it. This branch keeps the barrier: `crate::sync_directory` reopens
 *   the directory through `/proc/self/fd` and performs a real `fsync`, so nothing is given up and
 *   nothing is downgraded to a warning (`native/src/lib.rs`).
 * - #30's receipt cases assert that the message contains no machine path *by saying nothing about
 *   which artifact failed*. This branch names the artifact package-relatively
 *   (`runtime/<target>/provenance.json`) and reports the error code only — the assertions below pin
 *   that contract: actionable, and still free of the operator's install path.
 *
 * Everything else is #30's, kept as written.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveWorker, workerName } from '../lib/ptc/runtime.js'
import { mountBundledPwsh } from '../lib/session-pwsh.js'
import { FastCtxTools } from '../lib/tools.js'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')

function stageWorker(root) {
  const target = `${process.platform}-${process.arch}`
  const runtimeDir = path.join(root, 'runtime', target)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }))
  const worker = path.join(runtimeDir, workerName(process.platform))
  fs.writeFileSync(worker, 'worker-bytes')
  // POSIX: the resolver refuses a worker without an execute bit before it ever reads the receipt
  // (report L12), so the fixture has to be executable to reach the branch under test.
  if (process.platform !== 'win32') fs.chmodSync(worker, 0o755)
  return { target, runtimeDir, worker, receipt: path.join(runtimeDir, 'provenance.json') }
}

function captureWorker(root) {
  try { return { value: resolveWorker({}, { packageRoot: root }) } } catch (error) { return { error } }
}

await test('a missing provenance receipt names the artifact without naming the install path', async () => {
  await withTempDir('hardening-provenance-missing', (dir) => {
    const fixture = stageWorker(dir)
    const { error } = captureWorker(dir)
    assert.ok(error, 'a runtime without a receipt must not resolve')
    assert.match(error.message, /provenance receipt at runtime\/[^/]+\/provenance\.json could not be read \(ENOENT\)/)
    // The point of the contract: actionable (which artifact) and no absolute path, because a tool
    // error text can be echoed back to the model.
    assert.ok(!error.message.includes(dir), `the message leaked the install path: ${error.message}`)
    assert.ok(!error.message.includes(fixture.runtimeDir), 'the message must not name the runtime directory')
    assert.ok(!/no such file or directory/.test(error.message), 'the raw filesystem message must not be forwarded')
  })
})

await test('a malformed provenance receipt is a parse failure, not a leaked raw error', async () => {
  await withTempDir('hardening-provenance-malformed', (dir) => {
    const fixture = stageWorker(dir)
    fs.writeFileSync(fixture.receipt, '{ not json')
    const { error } = captureWorker(dir)
    assert.ok(error, 'a malformed receipt must not resolve')
    assert.match(error.message, /provenance receipt at runtime\/[^/]+\/provenance\.json is not valid JSON \(SyntaxError\)/)
    assert.ok(!error.message.includes(dir), `the message leaked the install path: ${error.message}`)
  })
})

await test('one pwsh row that refuses the update does not strand the rows behind it', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const updates = []
    const warnings = []
    const row = (name, update) => ({ options: { id: 'pwsh-sandbox', name, config: { pwshPath: 'original', retained: true } }, fiber: { state: 2, update } })
    const refusing = row('@deepseek-ai/dsh-pwsh-sandbox', () => { throw new Error('row refuses') })
    const following = row('@deepseek-ai/dsh-pwsh-sandbox', (raw, noSave) => updates.push({ raw, noSave }))
    const fixture = { inject(_deps, body) { body({
      get: () => ({ entries: () => [refusing, following] }),
      on: () => () => {},
      effect: (callback) => { callback() },
      logger: { warn: (message) => warnings.push(message) },
    }) } }
    mountBundledPwsh(fixture, { pwsh: { available: true, file: 'C:/pwsh.exe' } })
    assert.deepEqual(updates, [{ raw: { pwshPath: 'original', retained: true }, noSave: true }])
    assert.equal(warnings.length, 1, 'the refusal is reported once')
    assert.match(warnings[0], /rejected the update: row refuses/)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

await test('an exit during shutdown still kills the jobs this session owns', async () => {
  const killed = []
  const surface = new FastCtxTools({
    ctx: { get: () => undefined },
    config: { enableShellTools: true, toolCallTimeoutMs: 1000 },
    runtime: { file: 'fastctx', source: 'fixture', version: '0' },
    fileTools: false, commandTools: [], shared: true, report: () => {},
  })
  surface.bashAvailable = true
  surface.authorityAvailable = true
  surface.ownedJobs.set('sess-1', new Set(['j-aaaaaa', 'j-bbbbbb']))
  surface.client = { callTool: async (name, args) => { killed.push(`${name}:${args.job_id}`); return { isError: false } } }
  // The drain below clears both the client and the ledger, exactly as an exit during shutdown would.
  surface.pendingCalls.add(new Promise(resolve => setImmediate(() => {
    surface.client = undefined
    surface.ownedJobs.clear()
    resolve()
  })))
  await surface.stop()
  assert.deepEqual(killed, ['job_kill:j-aaaaaa', 'job_kill:j-bbbbbb'])
})

await test('provision leaves no copy that cannot run on the managed path', async () => {
  await withTempDir('hardening-provision', (dir) => {
    const home = path.join(dir, 'home')
    const source = path.join(dir, 'source', process.platform === 'win32' ? 'candidate.cmd' : 'candidate')
    fs.mkdirSync(path.dirname(source), { recursive: true })
    if (process.platform === 'win32') {
      fs.writeFileSync(source, '@echo off\r\nexit /b 7\r\n')
    } else {
      // Answers the provenance probe only while it lives beside its own source directory; the copy
      // the CLI installs therefore cannot run, which is the case under test.
      fs.writeFileSync(source, '#!/bin/sh\ncase "$(dirname "$0")" in\n  */source) echo "fastctx 9.9.9"; exit 0 ;;\nesac\nexit 7\n')
      fs.chmodSync(source, 0o755)
    }
    const managed = path.join(home, 'dsh-ops', 'bin', process.platform === 'win32' ? 'fastctx.exe' : 'fastctx')
    const result = spawnSync(process.execPath, [CLI, 'provision', '--from', source], {
      cwd: PACKAGE_ROOT, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(result.status, 1, `provision must refuse and exit 1, got ${result.status}: ${result.stderr}`)
    assert.match(`${result.stderr}${result.stdout}`, /the installed copy does not run/)
    assert.equal(fs.existsSync(managed), false, 'a copy that cannot run must not stay where resolution finds it first')
  })
})

report('hardening')
