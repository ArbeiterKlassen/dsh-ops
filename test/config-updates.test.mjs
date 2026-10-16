/** One-time per-row update self-check and owning-loader persistence. */
import { updatedConfig, mountConfigUpdates, CONFIG_UPDATE_VERSION } from '../lib/config-updates.js'
import { LEGACY_FASTCTX_KEYS, resolveConfig } from '../lib/config.js'
import { assert, report, test, tick, waitFor } from './lib/harness.mjs'

function fixture(config, { name = 'dsh-ops/shell', failWrite = false } = {}) {
  const writes = [], updates = [], logs = [], cleanup = []
  const entry = { options: { name, config }, parent: { tree: { write() {
    if (failWrite) throw new Error('read-only profile')
    writes.push(structuredClone(entry.options.config))
  } } }, async update({ config }) { entry.options.config = config; updates.push(config) } }
  const ctx = { fiber: { entry }, logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    effect(body) { cleanup.push(body()) } }
  return { entry, ctx, writes, updates, logs, cleanup }
}

await test('first run disables explicit true, marks completion, and preserves unrelated raw config', () => {
  const raw = { allowSystemShellFallback: true, bashPath: 'operator-choice', extraGuidance: 'keep', promptPolicy: { __jsExpr: 'true' } }
  const next = updatedConfig(raw)
  assert.equal(next.allowSystemShellFallback, false)
  assert.equal(next.configUpdateVersion, CONFIG_UPDATE_VERSION)
  assert.equal(next.promptPolicy, raw.promptPolicy)
  assert.equal(next.bashPath, raw.bashPath)
  assert.equal(raw.allowSystemShellFallback, true, 'never mutate input')
})
await test('evaluated true expressions are replaced but unrelated raw expressions survive write-back', async () => {
  const expression = { __jsExpr: 'true' }
  const other = { __jsExpr: 'true' }
  const f = fixture({ allowSystemShellFallback: expression, promptPolicy: other })
  mountConfigUpdates(f.ctx, { allowSystemShellFallback: true })
  await tick(); await tick()
  assert.equal(f.entry.options.config.allowSystemShellFallback, false)
  assert.equal(f.entry.options.config.promptPolicy, other)
  assert.equal(f.entry.options.config.configUpdateVersion, CONFIG_UPDATE_VERSION)
})

await test('self-check records first run even when fallback is absent or already false', () => {
  for (const raw of [{}, { allowSystemShellFallback: false }]) {
    const next = updatedConfig(raw)
    assert.equal(next.configUpdateVersion, CONFIG_UPDATE_VERSION)
    assert.equal(next.allowSystemShellFallback, raw.allowSystemShellFallback)
  }
})
await test('subsequent manual true and future version markers are not overwritten', () => {
  for (const configUpdateVersion of [CONFIG_UPDATE_VERSION, CONFIG_UPDATE_VERSION + 1]) {
    const raw = { configUpdateVersion, allowSystemShellFallback: true }
    assert.equal(updatedConfig(raw), raw)
    assert.equal(resolveConfig(updatedConfig(raw)).allowSystemShellFallback, true)
  }
  // A row already past step 1 keeps a later manual opt-in: step 1 never re-runs.
  const afterStepOne = updatedConfig({ configUpdateVersion: 1, allowSystemShellFallback: true }, true)
  assert.equal(afterStepOne.allowSystemShellFallback, true)
  assert.equal(afterStepOne.configUpdateVersion, CONFIG_UPDATE_VERSION)
  for (const value of [-1, '1', 1.5, true]) assert.throws(() => resolveConfig({ configUpdateVersion: value }), /configUpdateVersion/)
})
await test('update 2 drops the removed FastCtx keys from rows at version 0 and 1, and nothing else', () => {
  assert.equal(CONFIG_UPDATE_VERSION, 2)
  const legacy = { serverName: 'fastctx', enableShellTools: false, toolCallTimeoutMs: 300000 }
  for (const configUpdateVersion of [undefined, 0, 1]) {
    const raw = { ...(configUpdateVersion === undefined ? {} : { configUpdateVersion }), ...legacy, promptPolicy: true, required: false, binaryPath: 'C:\\w.exe' }
    const next = updatedConfig(raw)
    for (const key of LEGACY_FASTCTX_KEYS) assert.equal(Object.hasOwn(next, key), false, `${key} removed from version ${configUpdateVersion}`)
    assert.deepEqual({ promptPolicy: next.promptPolicy, required: next.required, binaryPath: next.binaryPath }, { promptPolicy: true, required: false, binaryPath: 'C:\\w.exe' })
    assert.equal(next.configUpdateVersion, 2)
    assert.equal(raw.serverName, 'fastctx', 'never mutate input')
  }
})
await test('an unmigrated row carrying the legacy keys still validates, and they are never returned', () => {
  // Exactly what the bundle patch wrote into every existing file row.
  const fileRow = { promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000 }
  const config = resolveConfig(fileRow)
  for (const key of LEGACY_FASTCTX_KEYS) assert.equal(Object.hasOwn(config, key), false)
  assert.equal(config.promptPolicy, true)
  assert.doesNotThrow(() => resolveConfig({ serverName: 'ops-tools' }))
  // Malformed legacy values still fail loud, as before.
  assert.throws(() => resolveConfig({ serverName: 'bad name!' }), /serverName/)
  assert.throws(() => resolveConfig({ enableShellTools: 'yes' }), /enableShellTools/)
  assert.throws(() => resolveConfig({ toolCallTimeoutMs: -1 }), /toolCallTimeoutMs/)
})
await test('a version-1 file row is written once with the legacy keys removed', async () => {
  const f = fixture({ configUpdateVersion: 1, promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000 }, { name: 'dsh-ops/file' })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  await tick(); await tick()
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.writes[0], { configUpdateVersion: 2, promptPolicy: true, required: false })
})
await test('write-back is deferred, once only, persistent across recreated contexts', async () => {
  const f = fixture({ allowSystemShellFallback: true, extraGuidance: 'keep' })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  mountConfigUpdates(f.ctx, f.entry.options.config)
  assert.equal(f.writes.length, 0)
  await tick(); await tick()
  assert.equal(f.writes.length, 1)
  assert.equal(f.entry.options.config.allowSystemShellFallback, false)
  assert.equal(f.entry.options.config.extraGuidance, 'keep')
  f.entry.options.config.allowSystemShellFallback = true
  const restart = fixture(JSON.parse(JSON.stringify(f.entry.options.config)))
  mountConfigUpdates(restart.ctx, restart.entry.options.config)
  await tick()
  assert.equal(restart.writes.length, 0)
  assert.equal(restart.entry.options.config.allowSystemShellFallback, true)
})
await test('no foreign row is written, and disposal cancels pending write-back', async () => {
  const foreign = fixture({ allowSystemShellFallback: true }, { name: 'other-plugin' })
  mountConfigUpdates(foreign.ctx, foreign.entry.options.config)
  await tick()
  assert.equal(foreign.writes.length, 0)
  const own = fixture({ allowSystemShellFallback: true })
  mountConfigUpdates(own.ctx, own.entry.options.config)
  for (const dispose of own.cleanup) dispose()
  await tick()
  assert.equal(own.writes.length, 0)
})
await test('write failure does not retain a completion marker and warns without dumping config', async () => {
  const f = fixture({ allowSystemShellFallback: true }, { failWrite: true })
  const original = f.entry.options.config
  mountConfigUpdates(f.ctx, original)
  await tick(); await tick()
  assert.equal(f.entry.options.config, original)
  assert.equal(f.entry.options.config.configUpdateVersion, undefined)
  assert.ok(f.logs.some(message => message.includes('could not be saved')))
  assert.equal(f.logs.some(message => message.includes('extraGuidance')), false)
})
await test('each component owns its marker, and concurrent config edits are preserved', async () => {
  for (const name of ['dsh-ops', 'dsh-ops/shell', 'dsh-ops/file']) {
    const f = fixture({ allowSystemShellFallback: true }, { name })
    mountConfigUpdates(f.ctx, f.entry.options.config)
    f.entry.options.config = { allowSystemShellFallback: false, extraGuidance: 'new edit' }
    await tick(); await tick()
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].extraGuidance, 'new edit')
    assert.equal(f.writes[0].configUpdateVersion, CONFIG_UPDATE_VERSION)
  }
  // The removed background row is a no-op stub; its saved config is never rewritten.
  const background = fixture({ enableShellTools: true }, { name: 'dsh-ops/background' })
  mountConfigUpdates(background.ctx, background.entry.options.config)
  await tick(); await tick()
  assert.equal(background.writes.length, 0)
})
await test('real component mount migrates before publication and preserves manual opt-in after restart', async () => {
  const { bootHost, shutdown, scopedToolNames } = await import('./lib/host.mjs')
  const { applyComponent } = await import('../lib/index.js')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { ctx } = await bootHost()
  const snapshots = [], effective = []
  let fiber
  const entry = { options: { name: 'dsh-ops/shell', config: { allowSystemShellFallback: true, bashPath: process.execPath } },
    parent: { tree: { write() { snapshots.push({ ...entry.options.config }) } } },
    async update({ config }) { entry.options.config = config; fiber.update(config, true) } }
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('not executed') } })
      inner.provide('sandboxPolicy', { resolve() { return { mode: 'danger-full-access' } } })
    })
    fiber = await ctx.plugin({ name: 'fixture-update-owner', apply(inner, raw) {
      inner.fiber.entry = entry
      effective.push(resolveConfig(updatedConfig(raw)).allowSystemShellFallback)
      applyComponent(inner, raw, 'shell')
    } }, entry.options.config)
    await waitFor(() => snapshots.length === 1 && effective.length >= 1, { timeoutMs: 5000 })
    assert.deepEqual(effective, [false])
    assert.equal(snapshots[0].allowSystemShellFallback, false)
    assert.equal(snapshots[0].configUpdateVersion, CONFIG_UPDATE_VERSION)
    // The component remains mounted and scoped tools remain available after
    // migration; the fix removes the redundant remount, not the mount itself.
    const agent = { id: 'migrated-agent', session: { header: { cwd: process.cwd() } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent, source: 'startup' })
    await waitFor(() => scopedToolNames(ctx, agent).includes('ops_bash'), { timeoutMs: 5000 })
    // A later ordinary profile edit still follows the host's normal update path.
    await entry.update({ config: { ...entry.options.config, allowSystemShellFallback: true } })
    await waitFor(() => effective.length === 2, { timeoutMs: 5000 })
    assert.equal(effective.at(-1), true)
    assert.equal(resolveConfig(fiber.config).allowSystemShellFallback, true)
    // Migration itself does not trigger a second mount or another disk write.
    assert.equal(snapshots.length, 1)
  } finally { await shutdown(ctx) }
})
report('config-updates')
