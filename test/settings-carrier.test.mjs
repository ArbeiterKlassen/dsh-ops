/** Real persistent composition, atomic writer and browser module activation. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as boot from '@deepseek-ai/dsh-app-boot'
import * as yaml from 'yaml'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { carrierPreview, applyCarrier } from '../lib/settings/carrier-write.js'
import { CLIENT_BUNDLE, profileContext } from '../lib/settings/carrier-plan.js'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { assert, test, report, PACKAGE_ROOT, waitFor } from './lib/harness.mjs'
const host = { boot, yaml, atomic }
const bundle = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const location = fixture => ({ dir: fixture.profile.dir, home: fixture.profile.home, installAnchor: fixture.profile.installAnchor })
const manifest = fixture => path.join(fixture.profile.dir, 'package.json')
const rows = fixture => boot.composeEntries([boot.readProfilePatches('dsh', profileContext(location(fixture)))])
const backups = fixture => fs.readdirSync(fixture.profile.dir).filter(name => name.startsWith('.dsh-ops-settings-backup-'))
const graph = ctx => ctx.get('clientModules').graph().entries.map(row => row.id)
const source = `# Preserve operator comments and expression semantics.
- id: dsh-ops-file
  name: dsh-ops/file
  disabled: false
  config:
    extraGuidance: keep operator text
    configUpdateVersion: 2
- id: dsh-ops-shell
  name: dsh-ops/shell
  disabled: !!js process.platform !== 'win32'
- id: dsh-ops-panel
  name: dsh-ops/panel
  disabled: true
  config:
    capture: false
- insert:
    - id: theme-sentinel
      name: cordis:fixtureTheme
      config:
        preference: dark
`
await test('default subpath preserves profiles; optional carrier survives reload and actual client activation', async () => {
  const fixture = componentProfile('carrier-composition', bundle)
  fs.writeFileSync(fixture.profile.patchPath, source)
  const metadata = JSON.parse(fs.readFileSync(manifest(fixture), 'utf8'))
  metadata.description = 'preserved profile metadata'; metadata.dependencies = { 'dsh-ops': '0.3.1' }
  fs.writeFileSync(manifest(fixture), JSON.stringify(metadata))
  const originalManifest = fs.readFileSync(manifest(fixture), 'utf8'), before = rows(fixture)
  let runtime = await fixture.boot()
  try {
    await runtime.ctx.plugin(ClientModuleRegistry)
    assert.deepEqual(graph(runtime.ctx), [], 'legacy subpath cannot advertise browser pages')
    await shutdown(runtime.ctx)
    const preview = await carrierPreview(host, location(fixture))
    assert.equal(preview.changedQualifiers, 1)
    assert.equal(fs.readFileSync(manifest(fixture), 'utf8'), originalManifest)
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), source)
    assert.deepEqual(backups(fixture), [])
    // A stop between these two writes remains a valid legacy profile.
    fs.writeFileSync(fixture.profile.patchPath, preview.files[0].after)
    assert.deepEqual(rows(fixture), before)
    fs.writeFileSync(fixture.profile.patchPath, source)
    const backup = await applyCarrier(host, preview)
    assert.equal(fs.readFileSync(path.join(backup, 'package.json'), 'utf8'), originalManifest)
    assert.equal(fs.readFileSync(path.join(backup, 'cordis.patch.yml'), 'utf8'), source)
    assert.match(fs.readFileSync(fixture.profile.patchPath, 'utf8'), /# Preserve operator comments/)
    assert.match(fs.readFileSync(fixture.profile.patchPath, 'utf8'), /!!js/)
    assert.deepEqual(rows(fixture), preview.afterRows)
    const resolution = await boot.createRuntimeResolution({ installAnchor: fixture.profile.installAnchor, home: fixture.profile.home,
      profile: boot.loadProfileDirectory('dsh', fixture.profile.dir, fixture.profile.installAnchor) })
    assert.ok(resolution.localPackageNames.includes('dsh-ops'), 'the real runtime resolver accepts the nested bundle')
    assert.equal(rows(fixture).length, 8, 'seven OPS rows plus unchanged foreign row')
    assert.equal(JSON.parse(fs.readFileSync(manifest(fixture), 'utf8')).description, metadata.description)
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest(fixture), 'utf8')).dsh.profile.bundles, [CLIENT_BUNDLE])
    for (let restart = 0; restart < 2; restart++) {
      runtime = await fixture.boot()
      await runtime.ctx.plugin(ClientModuleRegistry)
      assert.deepEqual(graph(runtime.ctx), ['dsh-ops'])
      assert.equal(runtime.entries().length, 7)
      assert.equal(runtime.entries().find(entry => entry.options.id === 'dsh-ops-file').options.config.extraGuidance, 'keep operator text')
      const entry = runtime.entries().find(entry => entry.options.id === 'dsh-ops-file')
      await entry.update({ disabled: true }); await runtime.ctx.loader.await()
      await waitFor(() => graph(runtime.ctx).length === 0)
      await entry.update({ disabled: false }); await runtime.ctx.loader.await()
      await waitFor(() => graph(runtime.ctx).includes('dsh-ops'))
      await shutdown(runtime.ctx)
    }
    await assert.rejects(carrierPreview(host, location(fixture)), /one-time migration/)
  } finally { await shutdown(runtime.ctx) }
})
await test('an explicitly disabled file carrier remains off until the builtin row switch enables it', async () => {
  const fixture = componentProfile('carrier-disabled', bundle, [{ id: 'dsh-ops-file', name: 'dsh-ops/file', disabled: true, config: { configUpdateVersion: 2 } }])
  const plan = await carrierPreview(host, location(fixture))
  await applyCarrier(host, plan)
  const runtime = await fixture.boot()
  try {
    await runtime.ctx.plugin(ClientModuleRegistry)
    assert.deepEqual(graph(runtime.ctx), [])
    const entry = runtime.entries().find(entry => entry.options.id === 'dsh-ops-file')
    assert.equal(entry.disabled, true)
    await entry.update({ disabled: false }); await runtime.ctx.loader.await()
    await waitFor(() => graph(runtime.ctx).includes('dsh-ops'))
  } finally { await shutdown(runtime.ctx) }
})
await test('stale preview, duplicate OPS rows and higher-priority named overrides refuse without writes', async () => {
  const fixture = componentProfile('carrier-stale', bundle)
  const plan = await carrierPreview(host, location(fixture))
  fs.appendFileSync(fixture.profile.patchPath, '\n# concurrent edit\n')
  await assert.rejects(applyCarrier(host, plan), /changed after the preview/)
  assert.deepEqual(backups(fixture), [])
  const duplicate = componentProfile('carrier-duplicate', bundle, [{ insert: [{ id: 'dsh-ops-file', name: 'dsh-ops/file' }] }])
  await assert.rejects(carrierPreview(host, location(duplicate)), /seven unique/)
  assert.deepEqual(backups(duplicate), [])
  const shadow = componentProfile('carrier-home-shadow', bundle)
  fs.writeFileSync(path.join(shadow.profile.home, 'cordis.patch.yml'), '- id: dsh-ops-file\n  name: dsh-ops/file\n  disabled: true\n')
  await assert.rejects(carrierPreview(host, location(shadow)), /External name-qualified/)
  assert.deepEqual(backups(shadow), [])
  // Matching current defaults is still a meaningful preference for later upgrades.
  const inheritedConfig = yaml.parse(bundle)[0].insert.find(row => row.id === 'dsh-ops-file').config
  fs.writeFileSync(path.join(shadow.profile.home, 'cordis.patch.yml'), JSON.stringify([{ id: 'dsh-ops-file', name: 'dsh-ops/file', config: inheritedConfig }]))
  await assert.rejects(carrierPreview(host, location(shadow)), /External name-qualified/)
  assert.deepEqual(backups(shadow), [])
})
await test('missing optional patches remain absent and host-invalid empty patches refuse unchanged', async () => {
  for (const content of [undefined, '', '# only a comment\n']) {
    const fixture = componentProfile(`carrier-empty-${String(content?.length)}`, bundle)
    if (content === undefined) fs.unlinkSync(fixture.profile.patchPath)
    else {
      fs.writeFileSync(fixture.profile.patchPath, content)
      await assert.rejects(carrierPreview(host, location(fixture)), /top-level YAML array/)
      assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), content)
      assert.deepEqual(backups(fixture), [])
      continue
    }
    const plan = await carrierPreview(host, location(fixture))
    assert.equal(plan.changedQualifiers, 0)
    await applyCarrier(host, plan)
    if (content === undefined) assert.equal(fs.existsSync(fixture.profile.patchPath), false)
    else assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), content)
    assert.deepEqual(rows(fixture), plan.afterRows)
  }
})
await test('atomic failure restores originals and retains a bounded recovery backup', async () => {
  for (const committedBeforeFailure of [false, true]) {
    const fixture = componentProfile(`carrier-rollback-${committedBeforeFailure}`, bundle)
    fs.writeFileSync(fixture.profile.patchPath, source)
    const plan = await carrierPreview(host, location(fixture))
    let calls = 0
    const faulty = { ...host, atomic: { ...atomic, async writeFileAtomic(file, text, options) {
      calls++
      if (calls === 2) {
        if (committedBeforeFailure) await atomic.writeFileAtomic(file, text, options)
        throw new Error('injected second-write failure')
      }
      return atomic.writeFileAtomic(file, text, options)
    } } }
    await assert.rejects(applyCarrier(faulty, plan), /Previous profile restored/)
    for (const file of plan.files) assert.equal(fs.readFileSync(file.path, 'utf8'), file.before)
    assert.deepEqual(rows(fixture), plan.beforeRows)
    assert.equal(backups(fixture).length, 1)
    // Prove the host profile lock was released and this is recoverable.
    await applyCarrier(host, await carrierPreview(host, location(fixture)))
    assert.deepEqual(rows(fixture), plan.afterRows)
  }
})
await test('CLI preview requires an explicit stopped-profile assertion before applying', async () => {
  const fixture = componentProfile('carrier-cli', bundle)
  fs.symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(path.dirname(fixture.profile.installAnchor), 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const args = [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'settings-profile', '--profile-dir', fixture.profile.dir,
    '--host-anchor', fixture.profile.installAnchor, '--dsh-home', fixture.profile.home]
  const run = (...extra) => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', env: process.env })
  const preview = run()
  assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /Preview only/)
  assert.deepEqual(backups(fixture), [])
  const refused = run('--yes')
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /--offline is required/)
  assert.deepEqual(backups(fixture), [])
  const applied = run('--yes', '--offline')
  assert.equal(applied.status, 0, applied.stderr); assert.match(applied.stdout, /Saved and verified/)
  assert.equal(backups(fixture).length, 1)
  assert.equal(rows(fixture).find(row => row.id === 'dsh-ops-file').name, 'dsh-ops')
})
report('settings-carrier')
