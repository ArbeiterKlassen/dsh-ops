import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { platformSurface } from '../lib/official-tool-catalog.js'
import { COMPONENTS, componentEnabled, SHELL_DISABLED_EXPRESSION } from '../lib/components/defaults.js'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const rows = parse(patch).flatMap(entry => entry.insert ?? [])
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
await test('seven stable row defaults and manifest agree, including the host-evaluated platform expression', () => {
  assert.equal(rows.length, 7)
  assert.deepEqual(rows.find(row => row.id === 'dsh-ops-shell').disabled, { __jsExpr: SHELL_DISABLED_EXPRESSION })
  for (const component of COMPONENTS) {
    const row = rows.find(row => row.id === `dsh-ops-${component}`)
    assert.ok(row)
    assert.equal(row.name, `dsh-ops/${component}`, 'legacy file name-qualified overrides must keep matching')
    const declared = manifest.contributes['x-components'].find(item => item.id === row.id)
    for (const platform of ['win32', 'linux', 'darwin']) {
      assert.equal(component === 'shell' ? declared.defaultEnabled[platform] : declared.defaultEnabled, componentEnabled(component, platform))
      if (component !== 'shell') assert.equal(row.disabled ?? false, !componentEnabled(component, platform))
    }
  }
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(platformSurface(platform).shellDefaultEnabled, platform === 'win32')
})
for (const platform of ['win32', 'linux', 'darwin']) await test(`real Loader applies fresh seven-row ${platform} defaults`, async () => {
  const fixture = componentProfile(`defaults-${platform}`, patch)
  const { ctx, entries } = await fixture.boot(platform)
  try {
    assert.equal(entries().length, 7)
    for (const entry of entries()) assert.equal(!entry.disabled, componentEnabled(entry.options.id.slice('dsh-ops-'.length), platform), entry.options.id)
    assert.equal(entries().find(entry => entry.options.id === 'dsh-ops-panel').options.config.capture, true)
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), '[]', 'startup does not write a composed tree')
  } finally { await shutdown(ctx) }
})
report('platform-defaults')
