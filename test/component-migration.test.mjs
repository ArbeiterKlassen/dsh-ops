import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT, waitFor } from './lib/harness.mjs'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
const current = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const previousRows = parse(current)[0].insert.filter(row => row.id !== 'dsh-ops-discovery')
for (const row of previousRows) {
  if (['dsh-ops-shell', 'dsh-ops-panel'].includes(row.id)) delete row.disabled
  if (row.id === 'dsh-ops-panel') row.config.capture = false
}
const previous = JSON.stringify([{ insert: previousRows }])
for (const reversed of [false, true]) await test(`six-to-seven bundle refresh and restart preserve named overrides (reverse: ${reversed})`, async () => {
  const choices = previousRows.map((row, index) => ({ id: row.id, name: row.name, disabled: Boolean(index % 2) !== reversed,
    config: { ...row.config, ...(row.id === 'dsh-ops-file' ? { extraGuidance: 'keep this exact file setting', configUpdateVersion: 2 } : {}),
      ...(row.id === 'dsh-ops-shell' ? { promptPolicy: false, configUpdateVersion: 2 } : {}),
      ...(row.id === 'dsh-ops-panel' ? { textLimit: 777, capture: false } : {}) } }))
  const foreign = { insert: [{ id: 'theme-sentinel', name: 'cordis:fixtureTheme', config: { preference: 'dark', fontSize: 17 } }] }
  const fixture = componentProfile(`migration-${reversed}`, previous, [...choices, foreign])
  const original = fs.readFileSync(fixture.profile.patchPath, 'utf8')
  const check = host => {
    for (const choice of choices) {
      const entry = host.entries().find(entry => entry.options.id === choice.id)
      assert.equal(entry.options.name, choice.name)
      assert.equal(entry.disabled, choice.disabled, `${choice.id} on/off preserved`)
      assert.deepEqual(entry.options.config, choice.config, `${choice.id} config preserved`)
    }
    const theme = [...host.ctx.loader.entries()].find(entry => entry.options.id === 'theme-sentinel')
    assert.deepEqual(theme.options.config, foreign.insert[0].config)
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original)
    assert.equal(fs.readFileSync(fixture.baseFile, 'utf8'), '[]\n')
  }
  let host = await fixture.boot('linux')
  try {
    assert.equal(host.entries().length, 6); check(host)
    fs.writeFileSync(fixture.bundlePath, current)
    await host.refresh()
    assert.equal(host.entries().length, 7); check(host)
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-discovery').disabled, false)
    await host.refresh(); assert.equal(host.entries().length, 7); check(host)
    await shutdown(host.ctx)
    host = await fixture.boot('linux')
    assert.equal(host.entries().length, 7); check(host)
  } finally { await shutdown(host.ctx) }
})
await test('fresh panel row enablement starts collection while explicit legacy false stays inert', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dsh-ops-panel-default-'))
  const fixture = componentProfile('panel-row-default', current)
  const host = await fixture.boot()
  const emit = id => host.ctx.emit('session/event', { id, header: { cwd } }, { type: 'user/message', seq: 0, time: 1,
    data: { content: [{ type: 'text', text: 'fresh panel row' }] } })
  const dir = path.join(cwd, '.dsh-ops/panel')
  try {
    emit('default-off')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(dir), false)
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops-panel', name: 'dsh-ops/panel', disabled: false }]))
    await host.refresh(); emit('enabled')
    await waitFor(() => fs.existsSync(path.join(dir, 'enabled.ndjson')))
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops-panel', name: 'dsh-ops/panel', disabled: false, config: { capture: false } }]))
    await host.refresh()
    const before = fs.readdirSync(dir)
    emit('legacy-off')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(fs.readdirSync(dir), before)
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-panel').fiber.config.capture, false)
  } finally { await shutdown(host.ctx); fs.rmSync(cwd, { recursive: true, force: true }) }
})
report('component-migration')
