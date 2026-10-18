/** Per-tool replacement through the host's scoped restriction and guard APIs.
 * Only explicit reviewed selections are masked. Missing selected counterparts
 * block the affected scope and restore its official tools until readiness returns.
 */
import { resolveHidingConfig } from './config.js'
export { resolveHidingConfig } from './config.js'
import { OFFICIAL_REPLACEMENTS } from './official-tool-catalog.js'
import { safeDispose } from './teardown.js'

export const name = 'dsh-ops-hide-official'
const blocked = detail => `READINESS_BLOCKED (EXECUTOR_UNAVAILABLE): dsh-ops hide-official cannot verify selected replacements: ${detail}. Restore the selected OPS tools, remove the selection from replaceTools, or disable the dsh-ops-hide-official row.`

export function apply(root, raw) {
  const { replaceTools } = resolveHidingConfig(raw)
  // Empty and legacy-only rows install no hooks and cannot block a session.
  if (!replaceTools.length) return
  const selected = new Set(replaceTools)
  const hideable = tool => selected.has(tool)
  root.inject(['tools', 'systemPrompt'], ctx => {
    const entries = new Map()
    let stopped = false, mutating = false, lastSurface
    const tools = ctx.get('tools')
    const apiError = ['schemas', 'get', 'restrict', 'guard'].filter(api => typeof tools[api] !== 'function')
    const fail = message => ctx.logger?.error?.(message)
    const clear = entry => {
      const pending = entry.lifts.splice(0)
      const failed = []
      for (const lift of pending) {
        if (!safeDispose(lift, error => fail(`dsh-ops: restriction cleanup failed: ${error.message}`), 'official-tool restriction')) failed.push(lift)
      }
      entry.lifts.push(...failed)
      entry.cleanupError = failed.length > 0 ? 'host restriction cleanup failed; retrying before proceeding' : undefined
      return failed.length === 0
    }
    // Readiness examines the unmasked scope. It never accepts ops_<same-name>
    // as an equivalence claim, nor uses run_code as a native replacement.
    const prepare = (agent, entry) => {
      const names = typeof tools.schemas === 'function' ? tools.schemas(agent).map(schema => schema.name) : []
      const hidden = names.filter(hideable)
      const missing = replaceTools.flatMap(tool => {
        const replacement = OFFICIAL_REPLACEMENTS[tool]
        return names.includes(replacement) && typeof tools.get === 'function' && tools.get(replacement, agent)
          ? [] : [`${tool} -> ${replacement}`]
      })
      const diagnostics = [
        ...apiError.length ? [`missing host API: ${apiError.join(', ')}`] : [],
        ...entry.cleanupError ? [entry.cleanupError] : [],
        ...missing.length ? [`missing OPS surface: ${[...new Set(missing)].join(', ')}`] : [],
      ]
      const failure = diagnostics.length ? blocked(diagnostics.join('; ')) : undefined
      // A failed plan hides nothing: no partial mask over an unready scope.
      return { deny: failure ? [] : hidden, failure }
    }
    // Compare public surfaces before touching masks. Other components also
    // reconcile tools/change; emitting a fresh restriction for an unchanged
    // surface would otherwise cause a publication/withdrawal feedback loop.
    const snapshot = () => JSON.stringify([tools.schemas(), ...[...entries.keys()].map(agent => tools.schemas(agent))])
    const reconcile = () => {
      if (stopped || mutating) return
      try { if (snapshot() === lastSurface) return } catch { /* reported by per-agent verification below */ }
      mutating = true
      try {
        // Clear all masks first: inherited restrictions must not conceal a
        // parent's missing capability while checking a child.
        for (const entry of entries.values()) clear(entry)
        const plans = []
        for (const [agent, entry] of entries) {
          let plan
          try { plan = prepare(agent, entry) }
          catch (error) { plan = { deny: [], failure: blocked(error.message) } }
          plans.push([agent, entry, plan])
        }
        // Each scope owns its readiness and mask. A failed child is blocked at
        // assembly/dispatch; it does not make a healthy ancestor or root fail.
        for (const [agent, entry, plan] of plans) {
          if (plan.failure) { clear(entry); entry.error = plan.failure; continue }
          try {
            // One restriction per complete plan; never partially hide when a
            // single required replacement is absent.
            if (plan.deny.length) entry.lifts.push(agent.ctx.tools.restrict({ deny: plan.deny }))
            const leaked = tools.schemas(agent).map(schema => schema.name).filter(hideable)
            if (leaked.length) throw new Error(`host scoped restriction cannot hide own-scope tools: ${leaked.join(', ')}`)
            entry.error = undefined
          } catch (error) { clear(entry); entry.error = blocked(error.message) }
        }
        for (const entry of entries.values()) {
          if (entry.error !== entry.reported) {
            if (entry.error) fail(entry.error)
            entry.reported = entry.error
          }
        }
        try { lastSurface = snapshot() } catch { lastSurface = undefined }
      } finally { mutating = false }
    }
    const block = (agent, detail) => {
      const message = blocked(detail)
      // Tool providers run before this waterfall, so keep the verified mask in
      // place for the next request's schema collection. Only this assembly
      // fails; invalidate readiness so transient provider errors are retryable.
      const entry = entries.get(agent)
      if (entry) entry.error = message
      lastSurface = undefined
      return new Error(message)
    }
    const attach = agent => {
      if (!agent?.ctx || entries.has(agent)) return
      entries.set(agent, { lifts: [], error: blocked('surface verification pending') })
      reconcile()
    }
    const refusal = exec => {
      if (stopped) return blocked('component disposed')
      if (!exec?.agent?.ctx) return blocked('calling agent scope unavailable')
      attach(exec.agent)
      reconcile() // Authority is live, not a startup snapshot.
      return entries.get(exec.agent)?.error
        ?? (hideable(exec.name) ? blocked(`official tool ${exec.name} is selected for replacement`) : undefined)
    }
    ctx.on('tools/pre-execute', (exec, next) => {
      const reason = refusal(exec)
      return reason ? { kind: 'deny', reason, info: { code: 'READINESS_BLOCKED' } } : next()
    })
    if (typeof tools.guard === 'function') ctx.effect(() => ctx.tools.guard(refusal), 'dsh-ops: replacement surface guard')
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      // A global diagnostic assembly is not an agent AI surface.
      if (!context.scope) return next()
      attach(context.scope)
      reconcile()
      const entry = entries.get(context.scope)
      const error = entry ? entry.error : blocked('agent scope cannot be verified')
      if (error) throw new Error(error)
      let result
      try { result = await next() }
      catch (error) { throw block(context.scope, `agent prompt assembly could not be verified: ${error.message}`) }
      reconcile()
      if (entry.error) throw new Error(entry.error)
      if (!Array.isArray(result?.tools)) throw block(context.scope, 'assembled tool schemas unavailable')
      const leaked = result.tools.map(schema => schema.name).filter(hideable)
      if (leaked.length) throw block(context.scope, `assembled surface still contains hidden official tools: ${leaked.join(', ')}`)
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
    }, 'dsh-ops: selected official-tool restrictions')
    for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
    if (apiError.length) fail(blocked(`missing host API: ${apiError.join(', ')}`))
  })
}
