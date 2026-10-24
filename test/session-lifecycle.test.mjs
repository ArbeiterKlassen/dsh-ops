import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mountSessionBash } from '../lib/session-shells.js'
import * as ptc from '../lib/ptc/index.js'
import * as discovery from '../lib/discovery/index.js'
import * as hiding from '../lib/official-tool-hiding.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
async function setup() {
  const host = await bootHost()
  await host.ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication tests must not execute') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
    inner.provide('ptcRuntime', { language: 'typescript' })
  })
  return host
}
function mint(ctx, id, mode = 'danger-full-access') {
  const agent = { id, session: { id, mode, header: { cwd: TEST_HOME } } }
  agent.ctx = createScope(ctx, agent).ctx
  return agent
}

await test('Bash authority events do not write the registry inside the session append window (#386)', async () => {
  const { ctx, tools } = await setup()
  let appending = false, rejected = 0
  const original = ToolRuntime.prototype.register
  ToolRuntime.prototype.register = function (...args) {
    if (appending) { rejected++; throw new Error('session append cannot reenter while another append is being published') }
    return original.apply(this, args)
  }
  try {
    const component = await ctx.plugin({ inject: ['tools'], apply(inner) {
      mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit' } })
    } })
    const fresh = mint(ctx, 'append-created')
    appending = true
    await ctx.serial('agent/created', { agent: fresh })
    appending = false
    await flush()
    assert.equal(rejected, 0, 'agent creation also defers publication')
    assert.ok(tools.get('ops_bash', fresh))
    const agent = mint(ctx, 'append-window', 'read-only')
    await ctx.serial('agent/created', { agent }); await flush()
    assert.equal(tools.get('ops_bash', agent), undefined)
    agent.session.mode = 'danger-full-access'
    appending = true
    ctx.emit('session/event', agent.session, { type: 'sandbox/mode' })
    appending = false
    await flush()
    assert.equal(rejected, 0, 'publication must happen after session event delivery returns')
    assert.ok(tools.get('ops_bash', agent), 'the newly authorized session receives Bash without a later unrelated event')
    const retained = tools.get('ops_bash', agent)
    let inside = 0
    ctx.on('tools/change', () => { if (appending) inside++ })
    agent.session.mode = 'read-only'
    appending = true
    ctx.emit('session/event', agent.session, { type: 'sandbox/mode' })
    appending = false
    const denied = await retained.execute({ command: 'must not run', description: 'Check deferred withdrawal' }, { agent, signal: new AbortController().signal })
    assert.equal(denied.status, 'failed', 'retained callbacks observe revoked authority before deferred cleanup')
    assert.match(denied.error, /AUTHORITY_CHANGED|EXECUTOR_UNAVAILABLE/)
    await flush()
    assert.equal(inside, 0, 'withdrawal also writes outside the append window')
    assert.equal(tools.get('ops_bash', agent), undefined)
    const waiting = mint(ctx, 'unload-before-publication')
    await ctx.serial('agent/created', { agent: waiting })
    await component.dispose(); await flush()
    assert.equal(tools.get('ops_bash', waiting), undefined, 'unload cancels publication queued by creation')
  } finally { appending = false; ToolRuntime.prototype.register = original; await shutdown(ctx) }
})

await test('PTC presentation waterfall accepts sections without pre-attached tools (#387)', async () => {
  const { ctx, tools, prompt } = await setup()
  try {
    await ctx.plugin(ptc, { binaryPath: process.execPath, required: true })
    const agent = mint(ctx, 'presentation-only')
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    await ctx.serial('agent/created', { agent }); await flush()
    await prompt.assemble({ scope: agent }); await flush()
    const before = tools.get('ops_load_sdk', agent)
    assert.ok(before)
    const assembly = await prompt.assemble({ scope: agent })
    const { tools: wire, ...presentation } = assembly
    assert.deepEqual(wire.map(tool => tool.name), ['run_code'])
    // rc.3 runs this public waterfall with PromptPresentation, then attaches
    // the authoritative tools snapshot after all listeners have returned.
    const result = await ctx.waterfall('system-prompt/assemble', presentation, { scope: agent }, async () => presentation)
    assert.equal(result, presentation)
    assert.equal(Object.hasOwn(result, 'tools'), false)
    assert.equal(tools.get('ops_load_sdk', agent), before, 'a valid PTC projection is retained')
    const selected = await before.execute({ tools: ['stat'] }, { agent, signal: new AbortController().signal })
    assert.equal(selected.status, 'completed')
  } finally { await shutdown(ctx) }
})
await test('first prompt waits for delayed discovery before selected replacement validation (#375)', async () => {
  const { ctx, prompt } = await setup()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const original = NativeFileTools.prototype.start
  NativeFileTools.prototype.start = async function (...args) {
    entered.resolve(); await release.promise
    return original.apply(this, args)
  }
  let created, assembling
  try {
    ctx.tools.register({ name: 'read', description: 'official read', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'unused' })
    await ctx.plugin(hiding, { replaceTools: ['read'] })
    await ctx.plugin(discovery, { binaryPath: process.execPath, required: true, enabled: false,
      allowedTools: ['inspect_local_file'], alwaysLoaded: ['inspect_local_file'] })
    const agent = mint(ctx, 'cold-start')
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    created = ctx.serial('agent/created', { agent })
    await entered.promise
    let settled = false
    assembling = prompt.assemble({ scope: agent }).finally(() => { settled = true })
    void assembling.catch(() => {}) // Awaited below; keep an early rejection owned while checking the pending state.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'the first prompt cannot treat pending publication as bad configuration')
    release.resolve()
    await created
    const first = await assembling
    assert.deepEqual(first.tools.map(tool => tool.name), ['ops_inspect_local_file'])
  } finally {
    release.resolve(); NativeFileTools.prototype.start = original
    await Promise.allSettled([created, assembling]); await shutdown(ctx)
  }
})
report('session-lifecycle')
