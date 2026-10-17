/** #170 baseline guard: no default flip without an explicit product decision. */
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { platformSurface } from '../lib/official-tool-catalog.js'

await test('0.3.1 baseline keeps shell enabled on all targets, PTC and hiding opt-in', () => {
  const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = parse(patch).flatMap(entry => entry.insert ?? [])
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
  const components = manifest.contributes['x-components']
  for (const [name, enabled] of [['shell', true], ['ptc', false], ['hide-official', false]]) {
    const row = rows.find(row => row.id === `dsh-ops-${name}`)
    const component = components.find(component => component.id === row.id)
    assert.equal(row.disabled ?? false, !enabled, name)
    assert.equal(component.defaultEnabled, enabled, name)
    // Do not rely on an extension field that the pinned host has not proven it consumes.
    assert.equal(Object.hasOwn(component, 'defaultEnabledPlatforms'), false)
  }
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(platformSurface(platform).shellDefaultEnabled, true)
  assert.doesNotMatch(patch, /!!js/)
})
report('platform-defaults')
