import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as OfficialTools from '@deepseek-ai/dsh-tool-fs'
import * as shell from '../../lib/components/shell/index.js'
import * as file from '../../lib/components/file/index.js'
import * as discovery from '../../lib/components/discovery/index.js'
import { pinnedBashExecutable } from '../../lib/shells/pinned.js'
let identity = 0
const textOf = content => content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/** Real AgentLoop, Session, tool dispatch and policy; only the model response is scripted. */
export async function boot({ root, worker, baselineSource, projection = 'candidate', alwaysLoaded = [], withShell = false }) {
  const shellFixture = withShell && process.env.DSH_OPS_TEST_BASH ? pinnedBashExecutable({ file: process.env.DSH_OPS_TEST_BASH }) : undefined
  const ctx = new Context(); ctx.logger.level = 0
  const queues = new Map(), requests = [], results = [], events = [], errors = []
  for (const plugin of [Agents, Sessions, Projections, Prompt]) await ctx.plugin(plugin, {})
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
  if (withShell) await ctx.plugin(Jobs, {})
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem, { cwd: root })
  await ctx.plugin(inner => {
    inner.provide('llm', { async prepareCall(config) { return { config, adapterDefaults: {}, stream: async function* (request) {
      assert.equal(request.purpose, undefined, 'auxiliary requests cannot spend a scripted ordinary round')
      const queue = queues.get(request.sessionId)
      assert.ok(queue?.length, 'unscripted provider request is forbidden')
      const script = queue.shift()
      const calls = typeof script === 'function' ? await script(request) : script
      requests.push({ sessionId: request.sessionId, tools: structuredClone(request.tools ?? []), messages: structuredClone(request.messages), toolCalls: calls.length })
      for (const [index, call] of calls.entries()) yield { type: 'tool-call-delta', index, id: call.id ?? 'bm-call-' + ++identity, name: call.name, argumentsDelta: JSON.stringify(call.args) }
      if (!calls.length) yield { type: 'text-delta', index: 0, text: 'Benchmark complete.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } })
    inner.on('tools/execute', async (exec, next) => {
      const result = await next()
      results.push({ sessionId: exec.agent?.session.id, callId: exec.callId, name: exec.name, arguments: exec.arguments, result: structuredClone(result) })
      return result
    })
    inner.on('agent/error', ({ error }) => errors.push(String(error?.stack ?? error)))
    inner.on('session/event', (session, event) => {
      if (event.type === 'tool/result') events.push({ sessionId: session.id, event: structuredClone(event), text: textOf(event.data.message.content) })
    })
  })
  if (projection === 'official') await ctx.plugin(OfficialTools, {})
  else if (projection === 'baseline') {
    const { NativeFileTools } = await import(pathToFileURL(join(baselineSource, 'lib/file/runtime.js')).href)
    await ctx.plugin({ inject: ['tools'], async apply(inner) {
      const runtime = new NativeFileTools({ ctx: inner, config: { workerPath: worker, required: true, denyCredentialReads: true } })
      await runtime.start(); inner.effect(() => () => runtime.stop())
    } })
  } else {
    await ctx.plugin(file, { binaryPath: worker, required: true })
    if (withShell) await ctx.plugin(shell, shellFixture ? { bashPath: shellFixture } : {})
    await ctx.plugin(discovery, { binaryPath: worker, required: true, alwaysLoaded })
  }
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 3 })
  async function agent(mode = 'workspace-write', parentAgent) {
    const { agent } = await ctx.get('agents').create({ sessionId: 'benchmark-' + ++identity, meta: { cwd: root }, parentAgent,
      agentOptions: { provider: 'fixture', model: 'scripted' } })
    setSandboxMode(agent.session, mode)
    return agent
  }
  async function run(agent, scripts) {
    assert.ok(scripts.length && scripts.at(-1).length === 0, 'scripts must end with a final response')
    const start = { requests: requests.length, results: results.length, events: events.length, errors: errors.length }
    queues.set(agent.session.id, [...scripts])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Execute the deterministic benchmark task.' }] }))
    await agent.whenIdle()
    assert.deepEqual(errors.slice(start.errors), [])
    assert.equal(queues.get(agent.session.id).length, 0, 'every scripted provider response must be consumed')
    const calls = requests.slice(start.requests), committed = events.slice(start.events)
    return { providerRequests: calls.length, toolBearingRounds: calls.filter(value => value.toolCalls > 0).length,
      requests: calls, results: results.slice(start.results), committed, outputBytes: committed.reduce((sum, value) => sum + Buffer.byteLength(value.text), 0) }
  }
  return { ctx, agent, run, shellFixture, close: () => ctx.fiber.dispose() }
}
