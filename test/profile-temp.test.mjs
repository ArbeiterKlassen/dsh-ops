import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { profileCommand } from '../lib/profile-install.js'
import { ensureSessionTemp, sessionTempDir } from '../lib/session-temp.js'

const capture = body => {
  const messages = [], previous = console.log
  console.log = value => messages.push(String(value))
  try { return { status: body(), messages } } finally { console.log = previous }
}
async function profileFixture(body) {
  await withTempDir('profile-delegate', async root => {
    const previous = { home: process.env.DSH_HOME, cli: process.env.DSH_OPS_DSH_CLI, spec: process.env.DSH_OPS_INSTALL_SPEC, exit: process.env.PROFILE_TEST_EXIT }
    process.env.DSH_HOME = root; delete process.env.DSH_OPS_DSH_CLI; delete process.env.DSH_OPS_INSTALL_SPEC
    const directory = path.join(root, 'profiles', 'dsh-tui'), receipt = path.join(root, 'invoked.json')
    fs.mkdirSync(directory, { recursive: true })
    const manifest = path.join(directory, 'package.json')
    fs.writeFileSync(manifest, JSON.stringify({ dependencies: { 'dsh-ops': '^0.3.1' }, dsh: { profile: { bundles: ['dsh-ops'] } } }))
    const cli = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh'); fs.mkdirSync(cli, { recursive: true })
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: './cli.mjs' } }))
    fs.writeFileSync(path.join(cli, 'cli.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.PROFILE_TEST_EXIT ?? 0))`)
    try { await body({ root, manifest, receipt }) } finally {
      for (const [key, value] of [['DSH_HOME', previous.home], ['DSH_OPS_DSH_CLI', previous.cli], ['DSH_OPS_INSTALL_SPEC', previous.spec], ['PROFILE_TEST_EXIT', previous.exit]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
    }
  })
}
await test('profile status and dry-run preserve the tui alias and never execute the official CLI', async () => {
  await profileFixture(({ receipt }) => {
    const status = capture(() => profileCommand('status', { profile: 'tui' }))
    assert.equal(status.status, 0)
    const value = JSON.parse(status.messages[0]); assert.equal(value.profile, 'dsh-tui'); assert.equal(value.enabled, true); assert.equal(value.dependency, '^0.3.1')
    assert.equal(capture(() => profileCommand('install', { profile: 'tui', dryRun: true })).status, 0)
    assert.equal(fs.existsSync(receipt), false)
    assert.throws(() => profileCommand('install', { profile: '../outside' }), /Explicit --profile/)
  })
})
await test('profile mutations delegate exact arguments and propagate official CLI failure without local rollback logic', async () => {
  await profileFixture(({ receipt, manifest }) => {
    const before = fs.readFileSync(manifest, 'utf8'); process.env.DSH_OPS_INSTALL_SPEC = 'dsh-ops@0.4.0-test'
    assert.equal(capture(() => profileCommand('install', { profile: 'tui' })).status, 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'add', 'dsh-ops@0.4.0-test'])
    process.env.PROFILE_TEST_EXIT = '17'
    assert.equal(capture(() => profileCommand('uninstall', { profile: 'dsh-tui' })).status, 17)
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'remove', 'dsh-ops'])
    assert.equal(fs.readFileSync(manifest, 'utf8'), before)
  })
})
await test('malformed profile manifest data fails before CLI invocation', async () => {
  await profileFixture(({ manifest, receipt }) => {
    fs.writeFileSync(manifest, 'null')
    assert.throws(() => profileCommand('status', { profile: 'tui' }), /Invalid package manifest/)
    fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: { bundles: 12 } } }))
    assert.throws(() => profileCommand('status', { profile: 'tui' }), /Invalid profile bundles/)
    assert.equal(fs.existsSync(receipt), false)
  })
})
await test('session temp identity is stable, isolated, idempotent and refuses file or link targets', async () => {
  await withTempDir('session-temp-types', async root => {
    const first = sessionTempDir('session-a', root), second = sessionTempDir('session-b', root)
    assert.equal(first, sessionTempDir('session-a', root)); assert.notEqual(first, second)
    assert.deepEqual(ensureSessionTemp(first), { ok: true }); assert.deepEqual(ensureSessionTemp(first), { ok: true })
    fs.writeFileSync(second, 'KEEP'); const failed = ensureSessionTemp(second)
    assert.equal(failed.ok, false); assert.match(failed.message, /could not create/); assert.equal(fs.readFileSync(second, 'utf8'), 'KEEP')
    const alias = path.join(root, 'alias'); fs.symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(ensureSessionTemp(alias).ok, false)
    if (process.platform !== 'win32') assert.equal(fs.statSync(first).mode & 0o777, 0o700)
  })
})
report('profile-temp')
