/** The actual assembled file/discovery lane, with the full catalogue measured separately. */
import fs from 'node:fs'
import path from 'node:path'
import { getEncoding } from 'js-tiktoken'
import * as file from '../lib/components/file/index.js'
import { FILE_TOOLS, publicToolName } from '../lib/policy.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { NATIVE_FILE_TOOLS } from '../lib/capabilities/registry.js'
import { bashToolDefinition } from '../lib/shells/tool.js'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { bootDiscoveryHost, mintDiscoveryAgent, discoveryNextStep } from './lib/discovery.mjs'
import { shutdown, scopedToolNames, registryNames, callTool } from './lib/host.mjs'

const INSPECT = publicToolName('read_many'), DISCOVER = publicToolName('discover')
const measure = tools => {
  const wire = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))
  return { tokens: getEncoding('cl100k_base').encode(wire).length, bytes: Buffer.byteLength(wire) }
}
async function mount(config) {
  const host = await bootDiscoveryHost(config)
  const fileFiber = await host.ctx.plugin(file, { required: true })
  await waitFor(() => registryNames(host.ctx).includes(INSPECT))
  return { ...host, fileFiber }
}
await test('the resident file row publishes one bounded reader even with the discovery entry disabled', () => withTempDir('resident', async dir => {
  const { ctx } = await mount({ enabled: false })
  try {
    const agent = await mintDiscoveryAgent(ctx, 'resident-disabled', dir)
    assert.deepEqual(registryNames(ctx), [INSPECT])
    assert.deepEqual(scopedToolNames(ctx, agent), [INSPECT])
    fs.writeFileSync(path.join(dir, 'read.txt'), 'bounded reader')
    const read = await callTool(ctx, INSPECT, { files: [{ path: 'read.txt' }] }, undefined, agent)
    assert.equal(read.value.status, 'completed')
    assert.match(read.text, /1 \| bounded reader/)
    const absent = await ctx.get('tools').execute({ agent, name: publicToolName('stat'), arguments: { path: 'read.txt' }, callId: 'absent', signal: new AbortController().signal })
    assert.equal(absent.isError, true)
  } finally { await shutdown(ctx) }
}))
await test('measure the full default Native surface including Bash and retain the unresolved BM-03 budget', () => withTempDir('resident', async dir => {
  const { ctx } = await mount()
  try {
    const agent = await mintDiscoveryAgent(ctx, 'resident-budget', dir)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [INSPECT, DISCOVER].sort())
    const core = measure(assembly.tools)
    const discovery = assembly.tools.find(tool => tool.name === DISCOVER)
    const full = measure([...NATIVE_FILE_TOOLS.map(raw => new NativeFileTools({ctx:{},config:{}}).definition(raw)), discovery])
    const shell = bashToolDefinition({ file: 'fixture', source: 'test', subprocess: {} })
    const withShell = measure([...assembly.tools, shell])
    console.log('  cl100k_base/js-tiktoken1.0.21 compact host-schema JSON:', JSON.stringify({ core, fullFileCatalogue: full, corePlusBash: withShell }))
    assert.equal(core.tokens, 291, JSON.stringify(core))
    assert.ok(full.tokens > 400 && full.tokens > core.tokens, 'retain honest full-surface measurement')
    assert.equal(withShell.tokens, 659, 'BM-03 remains unresolved until the full default, including Bash, fits400')
    const text = assembly.sections.map(section => section.text).join('\n')
    for (const raw of FILE_TOOLS.filter(raw => raw !== 'read_many')) assert.equal(text.includes(publicToolName(raw)), false)
    assert.ok(text.includes(DISCOVER))
    const selected = await callTool(ctx, DISCOVER, { query: 'select:ops_stat' }, undefined, agent)
    assert.deepEqual(selected.value.activated, [publicToolName('stat')])
    assert.equal(scopedToolNames(ctx, agent).includes(publicToolName('stat')), false)
    await discoveryNextStep(ctx, agent)
    const active = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.ok(active.sections.some(section => section.text.includes(publicToolName('stat'))))
  } finally { await shutdown(ctx) }
}))
await test('always-loaded choices explicitly expand the initial budget and survive file-row unload', () => withTempDir('resident', async dir => {
  const { ctx, fileFiber } = await mount({ allowedTools: ['glob', 'grep'], alwaysLoaded: ['glob', 'grep'] })
  try {
    const agent = await mintDiscoveryAgent(ctx, 'resident-expanded', dir)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [INSPECT, DISCOVER, publicToolName('glob'), publicToolName('grep')].sort())
    assert.ok(measure(assembly.tools).tokens > 400)
    await fileFiber.dispose()
    assert.deepEqual(scopedToolNames(ctx, agent), [DISCOVER, publicToolName('glob'), publicToolName('grep')].sort())
  } finally { await shutdown(ctx) }
}))
report('resident-tools')
