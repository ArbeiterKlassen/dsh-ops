/** Strict scoped takeover. No prompt-only hiding and no shared registry mutation. */
import { resolveHidingConfig } from './config.js'
export { resolveHidingConfig } from './config.js'
import { FILE_TOOLS, publicToolName } from './policy.js'
import { isOfficialTool, OFFICIAL_REPLACEMENTS, platformSurface } from './official-tool-catalog.js'
import { safeDisposeAll } from './teardown.js'

export const name = 'dsh-ops-hide-official'
const unavailable = detail => `EXECUTOR_UNAVAILABLE: dsh-ops strict official-tool takeover blocked: ${detail}. No mixed official/OPS surface is permitted. Ask the operator to install the missing OPS capability or disable the hiding component; do not retry or bypass.`

export function apply(root, raw) {
  const config = resolveHidingConfig(raw)
  const { retainedCommand } = platformSurface()
  const hiddenOfficial = name => name !== retainedCommand && isOfficialTool(name, config.additionalOfficialTools)
  root.inject(['tools', 'systemPrompt'], ctx => {
    const entries = new Map()
    let stopped = false, mutating = false, lastSurface
    const tools = ctx.get('tools')
    const apiError = ['schemas', 'get', 'restrict', 'guard'].filter(api => typeof tools[api] !== 'function')
    const warn = error => ctx.logger?.error?.(error)
    const clear = entry => {
      if (safeDisposeAll(entry.lifts.splice(0), error => warn(`dsh-ops: restriction cleanup failed: ${error.message}`))) {
        entry.cleanupError = 'host restriction cleanup failed; remount the agent before proceeding'
      }
    }
    // Readiness examines the unmasked scope. It never accepts ops_<same-name>
    // as an equivalence claim, nor uses run_code as a native replacement.
    const prepare = (agent, entry) => {
      const names = tools.schemas(agent).map(s => s.name)
      const missing = FILE_TOOLS.map(publicToolName).filter(n => !names.includes(n))
      const official = names.filter(hiddenOfficial)
      const unsupported = official.filter(n => n !== 'run_code' && !OFFICIAL_REPLACEMENTS[n])
      for (const n of official) {
        const replacement = OFFICIAL_REPLACEMENTS[n]
        if (replacement && !names.includes(replacement)) missing.push(`${n} -> ${replacement}`)
      }
      const diagnostics = [
        ...apiError.length ? [`missing host API: ${apiError.join(', ')}`] : [],
        ...entry.cleanupError ? [entry.cleanupError] : [],
        ...missing.length ? [`missing OPS surface: ${[...new Set(missing)].join(', ')}`] : [],
        ...unsupported.length ? [`no registered equivalent OPS capability: ${unsupported.join(', ')}`] : [],
        ...official.includes('run_code') ? ['unhideable official transport run_code; select native presentation'] : [],
      ]
      if (diagnostics.length) throw new Error(diagnostics.join('; '))
      return official
    }
    // Compare public surfaces before touching masks. Other components also
    // reconcile tools/change; emitting a fresh restriction for an unchanged
    // surface would otherwise cause a publication/withdrawal feedback loop.
    const snapshot = () => JSON.stringify([tools.schemas(), ...[...entries.keys()].map(agent => tools.schemas(agent))])
    const reconcile = () => {
      if (stopped || mutating) return
      try { if (snapshot() === lastSurface) return } catch { /* report via per-agent verification below */ }
      mutating = true
      try {
        // Clear all masks first: inherited restrictions must not conceal a
        // parent's missing capability while checking a child.
        for (const entry of entries.values()) clear(entry)
        const plans = []
        for (const [agent, entry] of entries) {
          try { plans.push([agent, entry, prepare(agent, entry)]) }
          catch (error) { entry.error = unavailable(error.message) }
        }
        // Restrictions inherit. If one agent cannot prove a complete takeover,
        // do not install ancestor masks that would partially hide its surface.
        if (plans.length !== entries.size) {
          for (const [, entry] of plans) entry.error = unavailable('another live agent has incomplete replacement readiness; inherited masks cannot be installed atomically')
        } else for (const [agent, entry, deny] of plans) {
          try {
            // One restriction per complete plan; never partially hide when a
            // single required replacement is absent.
            if (deny.length) entry.lifts.push(agent.ctx.tools.restrict({ deny }))
            const leaked = tools.schemas(agent).map(s => s.name).filter(hiddenOfficial)
            if (leaked.length) throw new Error(`host scoped restriction cannot hide own-scope tools: ${leaked.join(', ')}`)
            entry.error = undefined
          } catch (error) { clear(entry); entry.error = unavailable(error.message) }
        }
        if ([...entries.values()].some(entry => entry.error)) {
          for (const entry of entries.values()) clear(entry)
          for (const entry of entries.values()) entry.error ??= unavailable('another live agent failed host surface verification; inherited masks rolled back')
        }
        for (const entry of entries.values()) if (entry.error !== entry.reported) {
          if (entry.error) warn(entry.error)
          entry.reported = entry.error
        }
        try { lastSurface = snapshot() } catch { lastSurface = undefined }
      } finally { mutating = false }
    }
    const attach = agent => {
      if (!agent?.ctx || entries.has(agent)) return
      entries.set(agent, { lifts: [], error: unavailable('surface verification pending') })
      reconcile()
    }
    const refusal = exec => {
      if (stopped) return unavailable('component disposed')
      if (!exec?.agent?.ctx) return unavailable('calling agent scope unavailable')
      attach(exec.agent)
      reconcile() // Authority is live, not a startup snapshot.
      return entries.get(exec.agent)?.error
        ?? (hiddenOfficial(exec.name) ? unavailable(`official tool ${exec.name} is hidden`) : undefined)
    }
    ctx.on('tools/pre-execute', (exec, next) => {
      const reason = refusal(exec)
      return reason ? { kind: 'deny', reason, info: { code: 'EXECUTOR_UNAVAILABLE' } } : next()
    })
    if (typeof tools.guard === 'function') ctx.effect(() => ctx.tools.guard(refusal), 'dsh-ops: strict surface guard')
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      // A global diagnostic assembly is not an agent AI surface.
      if (!context.scope) return next()
      attach(context.scope)
      reconcile()
      const error = entries.has(context.scope) ? entries.get(context.scope).error : unavailable('agent scope cannot be verified')
      if (error) throw new Error(error)
      const result = await next()
      reconcile()
      if (entries.get(context.scope)?.error) throw new Error(entries.get(context.scope).error)
      const leaked = result.tools.map(s => s.name).filter(hiddenOfficial)
      if (leaked.length) throw new Error(unavailable(`assembled surface still contains official tools: ${leaked.join(', ')}`))
      return result
    })
    ctx.on('agent/created', ({ agent }) => attach(agent))
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = entries.get(agent)
      if (!entry) return
      mutating = true
      try { clear(entry); entries.delete(agent) } finally { mutating = false }
      reconcile()
    })
    ctx.on('tools/change', reconcile)
    ctx.effect(() => () => {
      stopped = true; mutating = true
      for (const entry of entries.values()) clear(entry)
      entries.clear()
    }, 'dsh-ops: strict official-tool restrictions')
    for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
    if (apiError.length) warn(unavailable(`missing host API: ${apiError.join(', ')}`))
  })
}
