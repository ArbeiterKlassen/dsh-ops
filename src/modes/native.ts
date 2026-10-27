/**
 * Resident native file surface for one enhanced preset mode.
 *
 * OPS file tools are registered per matching Agent at that Agent's scope, so a
 * session only sees the surface of the preset it was composed from and two mode
 * rows never compete for one registration. The controller re-reads the preset
 * when the registry reports a change, which is the only way a blank session can
 * move between modes.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { NativeFileTools } from '../file/runtime.js'
import { registerNativeProviderAtScope } from '../file/result-provider.js'
import { resolveWorker } from '../file/worker.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { BASH_TOOL, modeSectionName, MODE_SECTION_ORDERS, renderToolingPolicy } from '../policy.js'
import { visibleNames } from '../surface.js'
import type { ModeConfig } from './config.js'
import { modeOf } from './detect.js'
import { NATIVE_RESIDENT_RAW, MODE_PLANS } from './plan.js'
import { onModesChange } from './registry.js'
import type { ModeId } from './types.js'

type ResidentName = Parameters<NativeFileTools['definition']>[0]

interface Entry {
  agent: Agent
  ctx?: Context
  fiber?: Fiber
  runtime: NativeFileTools
  owned: Set<string>
  disposers: (() => void)[]
  ready: Promise<void>
}

/**
 * Publish the resident native file tools to sessions of one mode.
 * @param root - the mode row's context.
 * @param config - the row's resolved configuration.
 * @param mode - the mode the row enables.
 * @returns void; the caller owns the row lifetime through `ctx.effect`.
 */
export function mountNativeMode(root: Context, config: ModeConfig, mode: ModeId): void {
  let worker: string
  try { worker = resolveWorker({ binaryPath: config.binaryPath }) } catch (error) {
    if (config.required) throw error
    root.logger.warn(`dsh-ops: ${mode} mode cannot resolve its native worker; native file tools stay unpublished. ${String((error as Error)?.message ?? error)}`)
    return
  }
  const plan = MODE_PLANS[mode]
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools')
    const prompt = ctx.get('systemPrompt')
    if (!tools || !prompt) return
    mountResultLifecycle(ctx)
    const entries = new Map<Agent, Entry>()
    let stopped = false, mutating = false
    const clear = (entry: Entry): void => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} native publication cleanup failed: ${String(error)}`) }
      }
      entry.runtime.cancel('Mode row ownership changed')
      void entry.runtime.stop().catch(error => ctx.logger.warn(`dsh-ops: ${mode} native runtime stop failed: ${String(error)}`))
    }
    const publish = (agent: Agent, entry: Entry): void => {
      if (!entry.ctx) return
      const scope = agent
      const definitions = NATIVE_RESIDENT_RAW.map(name => entry.runtime.definition(name as ResidentName))
      const dispose = registerNativeProviderAtScope(entry.ctx, scope, definitions,
        tool => entry.ctx!.tools.register(tool), { inheritable: false, priority: 10 })
      entry.disposers.push(dispose)
      for (const definition of definitions) entry.owned.add(definition.name)
    }
    const cover = (agent: Agent): boolean => {
      const current = modeOf(ctx, agent)
      return current === mode
    }
    const attach = (agent: Agent): void => {
      if (stopped || entries.has(agent) || !agent?.ctx) return
      const entry: Entry = { agent, runtime: new NativeFileTools({ ctx, config: { workerPath: worker, required: config.required, denyCredentialReads: config.denyCredentialReads } }),
        owned: new Set(), disposers: [], ready: Promise.resolve() }
      entries.set(agent, entry)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(() => {
        if (stopped || entries.get(agent) !== entry || !entry.ctx) return
        return entry.runtime.start([]).then(() => {
          if (stopped || entries.get(agent) !== entry || !cover(agent)) return
          publish(agent, entry)
        })
      }).catch(error => ctx.logger.warn(`dsh-ops: ${mode} mode publication failed: ${String(error)}`))
    }
    const detach = (agent: Agent): void => {
      const entry = entries.get(agent)
      if (!entry) return
      entries.delete(agent)
      clear(entry)
      void entry.fiber?.dispose()
    }
    const reconcile = (): void => {
      if (stopped || mutating) return
      mutating = true
      try {
        for (const [agent, entry] of entries) if (!cover(agent)) detach(agent)
        for (const agent of ctx.get('agents')?.list?.() ?? []) if (cover(agent)) attach(agent)
      } finally { mutating = false }
    }
    ctx.on('agent/created', ({ agent }) => { if (cover(agent)) attach(agent) })
    ctx.on('agent/disposed', ({ agent }) => detach(agent))
    ctx.on('session/event', (_session, event) => {
      // A blank session may select another preset before its first turn; the mode
      // that no longer matches must withdraw its surface.
      if ((event as { type: string }).type === 'agent-preset/selected') reconcile()
    })
    ctx.effect(() => onModesChange(ctx, reconcile), `dsh-ops: ${mode} mode registry observer`)
    for (const agent of ctx.get('agents')?.list?.() ?? []) if (cover(agent)) attach(agent)
    if (plan.section !== null) {
      const suffix = `mode-${plan.section}`
      ctx.effect(() => prompt.section({
        name: modeSectionName(suffix), order: MODE_SECTION_ORDERS[suffix] ?? 3250, interpolate: false,
        text: context => {
          const agent = context.agent
          if (agent === undefined || !config.promptPolicy) return ''
          const entry = entries.get(agent)
          if (!entry || entry.owned.size === 0) return ''
          const visible = new Set(visibleNames(tools, agent))
          const published = [...entry.owned].filter(name => visible.has(name))
          // The Windows shell replacement is published by the shared shell row;
          // name it here when it is visible so routing text stays complete.
          if (visible.has(BASH_TOOL)) published.push(BASH_TOOL)
          return renderToolingPolicy({ published, shellComponent: true, extraGuidance: config.extraGuidance })
        },
      }), `dsh-ops: ${mode} tooling guidance`)
    }
    ctx.effect(() => () => {
      stopped = true
      for (const agent of [...entries.keys()]) detach(agent)
    }, `dsh-ops: ${mode} native lifecycle`)
  })
}
