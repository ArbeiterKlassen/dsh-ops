import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { platformSurface } from '../lib/official-tool-catalog.js'
import { COMPONENTS, componentEnabled } from '../lib/components/defaults.js'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { PTC_LOADABLE_TOOLS } from '../lib/ptc/config.js'
const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const rows = parse(patch).flatMap(entry => entry.insert ?? [])
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
await test('seven stable row defaults and manifest agree on every platform', () => {
  assert.equal(rows.length, 7)
  assert.equal(rows.find(row => row.id === 'dsh-ops-shell').disabled, undefined, 'the shell row is enabled by default on every platform')
  for (const component of COMPONENTS) {
    const row = rows.find(row => row.id === `dsh-ops-${component}`)
    assert.ok(row)
    assert.equal(row.name, `dsh-ops/${component}`, 'legacy file name-qualified overrides must keep matching')
    const declared = manifest.contributes['x-components'].find(item => item.id === row.id)
    for (const platform of ['win32', 'linux', 'darwin']) {
      assert.equal(declared.defaultEnabled, componentEnabled(component, platform))
      assert.equal(row.disabled ?? false, !componentEnabled(component, platform))
    }
  }
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(platformSurface(platform).shellDefaultEnabled, true)
})
for (const platform of ['win32', 'linux', 'darwin']) await test(`real Loader applies fresh seven-row ${platform} defaults`, async () => {
  const fixture = componentProfile(`defaults-${platform}`, patch)
  const { ctx, entries } = await fixture.boot(platform)
  try {
    assert.equal(entries().length, 7)
    for (const entry of entries()) assert.equal(!entry.disabled, componentEnabled(entry.options.id.slice('dsh-ops-'.length), platform), entry.options.id)
    assert.equal(entries().find(entry => entry.options.id === 'dsh-ops-panel').options.config.capture, true)
    const ptc = entries().find(entry => entry.options.id === 'dsh-ops-ptc')
    assert.deepEqual(ptc.fiber.config.allowedTools, PTC_LOADABLE_TOOLS, 'fresh PTC pool follows the implemented catalogue')
    assert.ok(ptc.fiber.config.allowedTools.includes('table_read'))
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), '[]', 'startup does not write a composed tree')
  } finally { await shutdown(ctx) }
})
await test('saved explicit PTC pools survive bundle refresh and a fresh profile boot', async () => {
  const choices = [{ id: 'dsh-ops-ptc', name: 'dsh-ops/ptc', config: { allowedTools: ['stat'], alwaysLoaded: [] } }]
  const fixture = componentProfile('defaults-saved-ptc', patch, choices)
  const original = fs.readFileSync(fixture.profile.patchPath, 'utf8')
  let host = await fixture.boot('linux')
  const check = () => {
    const entry = host.entries().find(value => value.options.id === 'dsh-ops-ptc')
    assert.deepEqual(entry.fiber.config.allowedTools, ['stat'])
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original)
  }
  try {
    check(); await host.refresh(); check()
    await shutdown(host.ctx); host = await fixture.boot('linux'); check()
  } finally { await shutdown(host.ctx) }
})
report('platform-defaults')
