import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { resolveDiscoveryConfig } from '../config.js'
import { NativeFileTools } from '../file/runtime.js'
import { definition } from '../file/contract.js'
import { failure, resolveWorker } from '../file/worker.js'
import { capability } from '../capabilities/registry.js'
import { DISCOVERY_DESCRIPTION, DISCOVERY_PARAMETERS, DISCOVERY_OUTPUT } from '../capabilities/discovery.js'
import { publicToolName, renderToolingPolicy } from '../policy.js'
import { DISCOVERABLE_TOOLS } from './config.js'
import type { DiscoverableName } from './config.js'
import { parseRequest, search } from './search.js'

interface Entry {
  ctx?: Context
  fiber?: Fiber
  runtime: NativeFileTools
  selected: Set<DiscoverableName>
  pending: Set<DiscoverableName>
  disposers: (() => void)[]
  owned: Set<string>
  ready: Promise<void>
}
const DISCOVER = publicToolName('discover')
const advanced = DISCOVERABLE_TOOLS.map(publicToolName)
export const name = 'dsh-ops-discovery'

export function apply(root: Context, raw: unknown): void {
  const config = resolveDiscoveryConfig(raw)
  let worker: string
  try { worker = resolveWorker(config) }
  catch (error) {
    if (config.required) throw error
    root.logger.warn('dsh-ops: discovery worker unavailable; no tools published.')
    return
  }
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], ctx => {
    const tools = ctx.get('tools'), prompt = ctx.get('systemPrompt'), policyService = ctx.get('sandboxPolicy')
    if (!tools || !prompt || !policyService) return
    const entries = new Map<Agent, Entry>()
    let stopped = false, mutating = false, epoch = 0, chain = Promise.resolve()
    const clear = (entry: Entry) => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch { ctx.logger.warn('dsh-ops: discovery registration cleanup failed.') }
      }
    }
    const permitted = (agent: Agent, rawName?: DiscoverableName): boolean => {
      try {
        const policy = policyService.resolve({ session: agent.session })
        return ['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
          && (!rawName || !capability(rawName)?.mutates || policy.mode !== 'read-only')
      } catch { return false }
    }
    const native = async (agent: Agent): Promise<boolean> => {
      const assembly = await prompt.assemble({ scope: agent })
      return !assembly.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim())
    }
    const own = (agent: Agent, entry: Entry, tool: ToolDefinition): void => {
      if (!entry.ctx) return
      const execute = tool.execute
      entry.disposers.push(entry.ctx.tools.register({ ...tool, execute: async (args, exec) => {
        if (stopped || entries.get(agent) !== entry || exec.agent !== agent || !entry.owned.has(tool.name)) {
          return failure('POLICY_DENIED', 'Discovery capability belongs to a different or inactive scope.')
        }
        return execute(args, exec)
      } }))
      entry.owned.add(tool.name)
    }
    const reconcile = (): Promise<void> => {
      if (stopped || mutating) return chain
      const version = ++epoch
      chain = chain.then(async () => {
        if (stopped || version !== epoch) return
        const ready: [Agent, Entry][] = []
        for (const [agent, entry] of entries) if (entry.ctx && permitted(agent) && await native(agent).catch(() => false)) ready.push([agent, entry])
        if (stopped || version !== epoch) return
        mutating = true
        try {
          for (const [agent, entry] of entries) {
            const isReady = ready.some(([candidate]) => candidate === agent)
            const wanted = isReady ? [...new Set([...config.alwaysLoaded, ...entry.selected])].filter(tool => permitted(agent, tool)) : []
            const desired = new Set([...(isReady && config.enabled ? [DISCOVER] : []), ...wanted.map(publicToolName)])
            const inherited = tools.schemas(agent).map(tool => tool.name).filter(tool => (advanced.includes(tool) || tool === DISCOVER) && !entry.owned.has(tool))
            // Registry changes from other components must not republish an unchanged
            // surface, or independent lifecycle listeners can amplify one another.
            if (desired.size === entry.owned.size && [...desired].every(tool => entry.owned.has(tool)) && !inherited.length) continue
            clear(entry)
            if (isReady && config.enabled) own(agent, entry, {
              name: DISCOVER, description: DISCOVERY_DESCRIPTION, parameters: DISCOVERY_PARAMETERS,
              output: { schema: DISCOVERY_OUTPUT, render: (_args, value) => [{ type: 'text', text: typeof value === 'object' && value && 'message' in value ? String(value.message) : JSON.stringify(value) }] },
              execute: async args => {
                const request = parseRequest(args)
                if (typeof request === 'string') return failure('INVALID_ARGUMENT', request)
                const matches = search(request.query, config.allowedTools.filter(tool => permitted(agent, tool)), Math.min(request.maxResults, config.maxResults))
                const activated = matches.filter(tool => !entry.selected.has(tool) && !config.alwaysLoaded.includes(tool))
                for (const tool of activated) entry.pending.add(tool)
                return { status: 'completed', activated: activated.map(publicToolName),
                  alreadyActive: matches.filter(tool => !activated.includes(tool)).map(publicToolName),
                  message: matches.length ? `Selected ${matches.map(publicToolName).join(', ')}. Newly selected tools become available on the next model step; no file action was executed.` : 'No allowed, implemented capability matched. Refine the query; unavailable formats cannot be activated.' }
              },
            })
            for (const tool of wanted) {
              own(agent, entry, definition(tool, (args, exec) => entry.runtime.call(tool, args, exec)))
            }
          }
          // A child must not inherit its parent's activation or an old global advanced surface.
          for (const [agent, entry] of entries) if (entry.ctx) {
            const deny = tools.schemas(agent).map(tool => tool.name)
              .filter(tool => (advanced.includes(tool) || tool === DISCOVER) && !entry.owned.has(tool))
            if (deny.length) entry.disposers.push(entry.ctx.tools.restrict({ deny }))
          }
        } finally { mutating = false }
      }).catch(() => {
        mutating = true
        try { for (const entry of entries.values()) clear(entry) } finally { mutating = false }
        ctx.logger.warn('dsh-ops: discovery publication unavailable; tools remain withdrawn.')
      })
      return chain
    }
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || entries.has(agent) || !agent.ctx) return entries.get(agent)?.ready ?? Promise.resolve()
      const entry: Entry = { runtime: new NativeFileTools({ ctx, config: { ...config, workerPath: worker }, report: undefined }),
        selected: new Set(), pending: new Set(), disposers: [], owned: new Set(), ready: Promise.resolve() }
      entries.set(agent, entry)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(async () => { await entry.runtime.start([]); await reconcile() })
      return entry.ready
    }
    ctx.on('agent/created', async ({ agent }) => { await attach(agent); return undefined })
    ctx.on('agent/pre-step', async (payload, next) => {
      await attach(payload.agent)
      const entry = entries.get(payload.agent)
      if (entry && !payload.signal.aborted) {
        for (const tool of entry.pending) if (permitted(payload.agent, tool)) entry.selected.add(tool)
        entry.pending.clear()
        await reconcile()
      }
      return next()
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      const entry = entries.get(agent)
      if (!entry) return
      entries.delete(agent); mutating = true
      try { clear(entry) } finally { mutating = false }
      await entry.runtime.stop(); await entry.fiber?.dispose(); await reconcile()
    })
    ctx.on('tools/change', () => { void reconcile() })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      mutating = true
      try {
        for (const [agent, entry] of entries) if (agent.session === session) {
          entry.pending.clear(); entry.runtime.cancel('Sandbox authority changed'); clear(entry)
        }
      } finally { mutating = false }
      void reconcile()
    })
    ctx.effect(() => prompt.section({
      name: 'dsh-ops:discovery-tools', order: 3253, interpolate: false,
      text: context => {
        const entry = entries.get(context.scope as Agent)
        return entry ? renderToolingPolicy({ published: entry.owned, shellComponent: false }) : ''
      },
    }), 'dsh-ops: discovered capability guidance')
    ctx.effect(() => async () => {
      stopped = true; ++epoch; mutating = true
      for (const entry of entries.values()) clear(entry)
      await Promise.allSettled([...entries.values()].map(async entry => { await entry.runtime.stop(); await entry.fiber?.dispose() }))
      entries.clear(); await chain
    }, 'dsh-ops: discovery lifecycle')
    for (const agent of ctx.get('agents')?.list() ?? []) void attach(agent)
  })
}
