/** Real host mount checks, also run before the legacy mount suite's runtime gate. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply } from '../../lib/official-tool-hiding.js'
import { platformSurface } from '../../lib/official-tool-catalog.js'
import { FILE_TOOLS, publicToolName } from '../../lib/policy.js'
import { assert, test, waitFor } from './harness.mjs'
import { bootHost, registryHasOwnRegister, registryNames, scopedToolNames, shutdown } from './host.mjs'

const tool = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => `ran:${name}` })
async function mint(ctx, id, parent) {
  const agent = { id, session: { id, header: { cwd: process.cwd() } } }
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
    agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx
  } })
  await ctx.serial('agent/created', { agent })
  return agent
}
async function mount(ctx, config = {}) {
  const fiber = await ctx.plugin({ name: 'fixture-strict-hide', apply }, config)
  // Injected fibers activate after the owning component's mount resolves.
  await new Promise(resolve => setImmediate(resolve))
  return fiber
}
function replacements(ctx) { return FILE_TOOLS.map(name => ctx.tools.register(tool(publicToolName(name)))) }
const assemble = (ctx, agent) => ctx.get('systemPrompt').assemble({ scope: agent })
const execute = (ctx, agent, name) => ctx.get('tools').execute({ agent, name, arguments: {}, callId: 'hide-test', signal: new AbortController().signal })

export async function officialToolHidingMountChecks() {
  await test('strict hiding removes official schemas and dispatch, preserves unrelated scopes, and lifts on unload', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx)
      const retained = platformSurface().retainedCommand
      for (const name of ['read', 'glob', 'grep', retained, 'foreign']) ctx.tools.register(tool(name))
      const existing = await mint(ctx, 'existing-hide-agent')
      await ctx.plugin(inner => inner.provide('agents', { list: () => [existing] }))
      const hiding = await mount(ctx)
      const current = await mint(ctx, 'new-hide-agent')
      for (const agent of [existing, current]) {
        const names = scopedToolNames(ctx, agent)
        for (const name of ['read', 'glob', 'grep']) {
          assert.equal(names.includes(name), false)
          assert.equal(ctx.tools.get(name, agent), undefined)
          assert.ok(registryNames(ctx).includes(name))
        }
        assert.ok(names.includes(retained)); assert.ok(names.includes('foreign'))
        const assembly = await assemble(ctx, agent)
        assert.deepEqual(assembly.tools.map(s => s.name).sort(), names)
      }
      assert.equal(registryHasOwnRegister(ctx), false)
      for (const api of ['restrict', 'guard', 'schemas', 'get']) assert.equal(Object.hasOwn(ctx.get('tools'), api), false)
      const first = await mint(ctx, 'foreign-scope-one'), second = await mint(ctx, 'foreign-scope-two')
      for (const agent of [first, second]) agent.ctx.tools.register(tool('foreign-local'))
      assert.equal(registryNames(ctx).includes('foreign-local'), false)
      assert.ok((await execute(ctx, current, 'read')).isError)
      assert.equal((await execute(ctx, current, 'foreign')).isError, false)
      await hiding.dispose()
      assert.ok(scopedToolNames(ctx, current).includes('read'))
      assert.equal((await execute(ctx, current, 'read')).isError, false)
      assert.ok((await assemble(ctx, current)).tools.some(t => t.name === 'read'))
    } finally { await shutdown(ctx) }
  })
  await test('missing equivalence fails prompt assembly and monotonic execution without partial hiding', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx)
      for (const name of ['read', 'write', 'web_search', 'subagent', 'ask_user_question', 'plan', 'foreign', 'ops_write']) ctx.tools.register(tool(name))
      await mount(ctx)
      const agent = await mint(ctx, 'incomplete-takeover')
      await assert.rejects(() => assemble(ctx, agent), /no registered equivalent OPS capability:.*write.*web_search.*subagent.*ask_user_question.*plan/)
      for (const name of ['read', 'write', 'web_search']) assert.ok(scopedToolNames(ctx, agent).includes(name))
      // An extensible listener cannot turn the final guard back into allow.
      ctx.on('tools/pre-execute', () => ({ kind: 'allow' }), { prepend: true })
      const result = await execute(ctx, agent, 'foreign')
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /EXECUTOR_UNAVAILABLE/)
      assert.doesNotMatch(result.content[0].text, /POLICY_DENIED/)
    } finally { await shutdown(ctx) }
  })
  await test('replacement withdrawal restores official tools but blocks the turn until readiness returns', async () => {
    const { ctx } = await bootHost()
    try {
      const disposers = replacements(ctx)
      ctx.tools.register(tool('read'))
      await mount(ctx)
      const agent = await mint(ctx, 'live-readiness')
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      disposers[0]()
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
      await assert.rejects(() => assemble(ctx, agent), /missing OPS surface:.*ops_inspect_local_file/)
      ctx.tools.register(tool(publicToolName(FILE_TOOLS[0])))
      await waitFor(() => !scopedToolNames(ctx, agent).includes('read'))
      await assemble(ctx, agent)
      const disposeWrite = ctx.tools.register(tool('write'))
      await assert.rejects(() => assemble(ctx, agent), /no registered equivalent OPS capability: write/)
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
      disposeWrite()
      await assemble(ctx, agent)
    } finally { await shutdown(ctx) }
  })
  await test('own-scope official registration cannot be silently hidden by an inherited restriction', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx)
      await mount(ctx)
      const agent = await mint(ctx, 'own-official')
      agent.ctx.tools.register(tool('read'))
      await assert.rejects(() => assemble(ctx, agent), /unknown global tool|cannot hide own-scope/)
      assert.equal((await execute(ctx, agent, 'read')).isError, true)
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
  await test('run_code is a blocked unhideable official transport, not a platform exception', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx)
      ctx.provide('ptcRuntime', { language: 'typescript' })
      await mount(ctx)
      const agent = await mint(ctx, 'transport-not-exempt')
      const lift = agent.ctx.tools.presentAs('both')
      await assert.rejects(() => assemble(ctx, agent), /unhideable official transport run_code/)
      assert.equal((await execute(ctx, agent, publicToolName('glob'))).isError, true)
      lift()
      await assemble(ctx, agent)
    } finally { await shutdown(ctx) }
  })
  await test('official dynamic prefixes and configured aliases fail readiness without hiding third-party tools', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx)
      for (const name of ['custom_delegate', 'stagehand_tabs', 'cua_driver_native__click', 'foreign']) ctx.tools.register(tool(name))
      await mount(ctx, { additionalOfficialTools: ['custom_delegate'] })
      const agent = await mint(ctx, 'official-alias')
      await assert.rejects(() => assemble(ctx, agent), /custom_delegate.*stagehand_tabs.*cua_driver_native__click/)
      assert.ok(scopedToolNames(ctx, agent).includes('foreign'))
    } finally { await shutdown(ctx) }
  })
  await test('an unrelated root with local write does not stop a healthy root', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      await mount(ctx)
      const a = await mint(ctx, 'independent-a'), b = await mint(ctx, 'independent-b')
      await assemble(ctx, a); await assemble(ctx, b)
      const liftWrite = b.ctx.tools.register(tool('write'))
      await assert.rejects(() => assemble(ctx, b), /no registered equivalent OPS capability: write/)
      assert.equal((await execute(ctx, b, 'foreign')).isError, true)
      assert.ok(scopedToolNames(ctx, b).includes('read'), 'failed root has no partial mask')
      assert.equal(scopedToolNames(ctx, a).includes('read'), false)
      await assemble(ctx, a)
      assert.equal((await execute(ctx, a, 'foreign')).isError, false)
      liftWrite()
      await assemble(ctx, b)
      assert.equal(scopedToolNames(ctx, b).includes('read'), false)
    } finally { await shutdown(ctx) }
  })
  await test('a failed child is blocked without stopping its healthy parent or unrelated root', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      const hiding = await mount(ctx)
      const parent = await mint(ctx, 'independent-parent')
      const other = await mint(ctx, 'independent-root')
      const child = await mint(ctx, 'independent-child', parent)
      child.ctx.tools.register(tool('read'))
      await assert.rejects(() => assemble(ctx, child), /cannot hide own-scope/)
      assert.equal((await execute(ctx, child, 'foreign')).isError, true)
      assert.ok(scopedToolNames(ctx, child).includes('read'))
      for (const agent of [parent, other]) {
        await assemble(ctx, agent)
        assert.equal((await execute(ctx, agent, 'foreign')).isError, false)
        assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      }
      await ctx.serial('agent/disposed', { agent: child })
      await assemble(ctx, parent)
      await hiding.dispose()
      for (const agent of [parent, child, other]) assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
  await test('inherited masks cannot conceal a child missing an OPS replacement', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      await mount(ctx)
      const parent = await mint(ctx, 'ready-parent')
      const child = await mint(ctx, 'filtered-child', parent)
      const lift = child.ctx.tools.restrict({ deny: [publicToolName('inspect_local_file')] })
      await assert.rejects(() => assemble(ctx, child), /missing OPS surface:.*ops_inspect_local_file/)
      assert.equal((await execute(ctx, child, 'foreign')).isError, true)
      await assemble(ctx, parent)
      assert.equal(scopedToolNames(ctx, parent).includes('read'), false)
      lift()
      await assemble(ctx, child)
      assert.equal(scopedToolNames(ctx, child).includes('read'), false)
    } finally { await shutdown(ctx) }
  })
  await test('missing host restriction/guard APIs block assembly with infrastructure diagnostics', async () => {
    const { ctx } = await bootHost({ withTools: false })
    try {
      // API-drift fixture, not an override of any shared registry method.
      ctx.provide('tools', { schemas: () => FILE_TOOLS.map(n => ({ name: publicToolName(n) })), get() {} })
      await mount(ctx)
      const agent = await mint(ctx, 'missing-host-api')
      await assert.rejects(() => assemble(ctx, agent), /missing host API: restrict, guard/)
      const decision = await ctx.waterfall('tools/pre-execute', { agent, name: 'foreign' }, () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'deny')
      assert.equal(decision.info.code, 'READINESS_BLOCKED')
    } finally { await shutdown(ctx) }
  })
  await test('assembled official schema injection is rejected even when registry masking succeeded', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx); ctx.tools.register(tool('read'))
      await mount(ctx)
      const agent = await mint(ctx, 'assembly-verification')
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const result = await next()
        result.tools.push({ name: 'web_search', description: 'injected', parameters: {} })
        return result
      })
      await assert.rejects(() => assemble(ctx, agent), /assembled surface still contains official tools: web_search/)
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false, 'assembly failure preserves the verified registry mask')
      await assert.rejects(() => assemble(ctx, agent), /assembled surface still contains official tools: web_search/)
    } finally { await shutdown(ctx) }
  })
  await test('a fail-once prompt provider blocks only that assembly and recovers on the next request', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      await mount(ctx)
      const a = await mint(ctx, 'transient-a'), b = await mint(ctx, 'transient-b')
      await assemble(ctx, a); await assemble(ctx, b)
      let failOnce = true
      ctx.on('system-prompt/assemble', (assembly, context, next) => {
        if (context.scope === a && failOnce) { failOnce = false; throw new Error('transient fixture failure') }
        return next()
      })
      await assert.rejects(() => assemble(ctx, a), /could not be verified: transient fixture failure/)
      assert.equal(scopedToolNames(ctx, a).includes('read'), false)
      assert.equal(scopedToolNames(ctx, b).includes('read'), false, 'other root keeps its restriction')
      const recovered = await assemble(ctx, a)
      assert.equal(recovered.tools.some(t => t.name === 'read'), false)
      assert.equal((await execute(ctx, a, 'foreign')).isError, false)
      await assemble(ctx, b)
      assert.equal((await execute(ctx, b, 'foreign')).isError, false)
    } finally { await shutdown(ctx) }
  })
  await test('agent disposal lifts restrictions and remount does not retain old masks', async () => {
    const { ctx } = await bootHost()
    try {
      replacements(ctx); ctx.tools.register(tool('read'))
      const first = await mount(ctx)
      const agent = await mint(ctx, 'disposal')
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      await ctx.serial('agent/disposed', { agent })
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
      await first.dispose()
      const second = await mount(ctx)
      await ctx.serial('agent/created', { agent })
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      await second.dispose()
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
}
