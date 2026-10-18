/** Strict scoped takeover of the shell, file and PTC faces.
 *
 * `strict` is deliberately *not* "no official tool anywhere may survive". The
 * host keeps capabilities dsh-ops never replaces (delegation, teams, jobs,
 * sessions, media, scheduling), and treating each of them as fatal made the
 * component unusable on a stock desktop profile (#207/#238). It now means:
 * inside the three faces dsh-ops takes over, hide only what has a reviewed
 * replacement; keep everything else visible and warn with names.
 *
 * Fail-closed survives for exactly one case: an in-scope tool listed explicitly
 * in `additionalOfficialTools` while no replacement is registered. That request
 * cannot be honored without a mixed surface, so the scope stays unready and the
 * message names both ways out (drop the name, or disable the row).
 */
import { resolveHidingConfig } from './config.js'
export { resolveHidingConfig } from './config.js'
import { FILE_TOOLS, publicToolName } from './policy.js'
import { isOfficialTool, OFFICIAL_REPLACEMENTS, platformSurface } from './official-tool-catalog.js'
import { safeDispose } from './teardown.js'

export const name = 'dsh-ops-hide-official'

/**
 * The official-tool faces dsh-ops takes over — shell, file, PTC — and nothing
 * else. Names are pinned official tool names, so a third-party tool is never
 * classified by guesswork; a configurable alias is classified only when the
 * operator lists it in `additionalOfficialTools`, and even then it stays
 * outside this scope.
 */
export const TAKEOVER_SCOPE = Object.freeze({
  shell: Object.freeze(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent']),
  file: Object.freeze(['read', 'glob', 'grep', 'write', 'edit', 'str_replace_editor']),
  ptc: Object.freeze(['run_code']),
})
const FACE_BY_TOOL = new Map(Object.entries(TAKEOVER_SCOPE)
  .flatMap(([face, names]) => names.map(tool => [tool, face])))

/** The takeover face of an official tool, or `undefined` when outside scope. */
export function takeoverFace(tool) { return FACE_BY_TOOL.get(tool) }

/**
 * Whether dsh-ops is prepared to hide this official tool.
 *
 * Hiding requires all three: a takeover face, no reliance on the platform's
 * retained host shell, and a reviewed entry in `OFFICIAL_REPLACEMENTS`. A
 * similarly named registration is still not evidence of equivalence, and an
 * `additionalOfficialTools` entry cannot extend hiding beyond the scope.
 * @param {string} tool - the official tool name.
 * @param {string} [platform] - the platform whose retained shell is exempt.
 * @returns {boolean} whether the tool is a hide candidate.
 */
export function isHideable(tool, platform = process.platform) {
  if (tool === platformSurface(platform).retainedCommand) return false
  return takeoverFace(tool) !== undefined && OFFICIAL_REPLACEMENTS[tool] !== undefined
}

/**
 * Split the presented surface into hide candidates and kept-visible tools.
 *
 * Never throws and never decides readiness: out-of-scope tools are the host's
 * business, and in-scope tools without a replacement stay visible. The only
 * readiness-shaped output is `explicitUnsupported` (see {@link surfaceWarning}
 * and the explicit-blocked message in `apply`).
 * @param {string[]} names - tool names the scope presents.
 * @param {{additionalOfficialTools: string[]}} [config] - resolved hiding config.
 * @param {string} [platform] - platform deciding the retained host shell.
 * @returns {object} classified surface, with every list sorted by tool name.
 */
export function classifyOfficialSurface(names, config = resolveHidingConfig(), platform = process.platform) {
  const { retainedCommand } = platformSurface(platform)
  const explicit = new Set(config.additionalOfficialTools ?? [])
  const official = [...new Set(names)].filter(tool => isOfficialTool(tool, [...explicit])).sort()
  const surface = {
    retainedCommand, official,
    hidden: [], inScopeUnsupported: [], explicitUnsupported: [], outOfScope: [], explicitOutOfScope: [],
  }
  for (const tool of official) {
    if (tool === retainedCommand) continue
    const face = takeoverFace(tool)
    if (face !== undefined && OFFICIAL_REPLACEMENTS[tool] !== undefined) surface.hidden.push(tool)
    else if (face !== undefined) surface[explicit.has(tool) ? 'explicitUnsupported' : 'inScopeUnsupported'].push(tool)
    else surface[explicit.has(tool) ? 'explicitOutOfScope' : 'outOfScope'].push(tool)
  }
  return surface
}

const count = (total, one, many) => `${total} ${total === 1 ? one : many}`

/**
 * One readable warning for everything that stays visible, or `undefined`.
 *
 * The text names every tool: an operator must be able to tell which official
 * tools were not hidden and why, without reading the source. It never contains
 * `READINESS_BLOCKED`: these tools do not stop the session.
 * @param {ReturnType<typeof classifyOfficialSurface>} surface - classified surface.
 * @returns {string|undefined} the warning sentence group.
 */
export function surfaceWarning(surface) {
  const keptOut = [...surface.outOfScope, ...surface.explicitOutOfScope].sort()
  const parts = []
  if (keptOut.length) {
    parts.push(`${count(keptOut.length, 'official tool stays', 'official tools stay')} visible because ${keptOut.length === 1 ? 'it is' : 'they are'} outside the dsh-ops takeover scope (shell/file/ptc): ${keptOut.join(', ')}`)
    if (surface.explicitOutOfScope.length) {
      parts.push(`the explicit additionalOfficialTools request for ${surface.explicitOutOfScope.join(', ')} is ignored: strict never fails on out-of-scope tools`)
    }
  }
  if (surface.inScopeUnsupported.length) {
    parts.push(`${count(surface.inScopeUnsupported.length, 'in-scope official tool stays', 'in-scope official tools stay')} visible because no registered OPS equivalent exists: ${surface.inScopeUnsupported.join(', ')}; list one in additionalOfficialTools to fail closed deliberately`)
  }
  return parts.length ? `dsh-ops hide-official: ${parts.join('. ')}.` : undefined
}

const blocked = detail => `READINESS_BLOCKED (EXECUTOR_UNAVAILABLE): dsh-ops hide-official cannot verify its takeover scope: ${detail}. No official tool inside shell/file/ptc stays hidden while this scope is unready; official tools outside those faces are unaffected by strict.`
const explicitBlocked = names => `READINESS_BLOCKED (HIDING_REQUEST_UNSATISFIABLE): dsh-ops hide-official cannot honor an explicit hide request inside its shell/file/ptc takeover scope: no registered OPS equivalent exists for ${names.join(', ')}. Fix: remove ${names.map(tool => `"${tool}"`).join(', ')} from additionalOfficialTools (each tool then stays visible and only warns), or disable the dsh-ops-hide-official row.`

export function apply(root, raw) {
  const config = resolveHidingConfig(raw)
  platformSurface() // Refuse an unknown platform before any surface work.
  const hideable = tool => isHideable(tool)
  root.inject(['tools', 'systemPrompt'], ctx => {
    const entries = new Map()
    let stopped = false, mutating = false, lastSurface
    const tools = ctx.get('tools')
    const apiError = ['schemas', 'get', 'restrict', 'guard'].filter(api => typeof tools[api] !== 'function')
    const fail = message => ctx.logger?.error?.(message)
    const warn = message => ctx.logger?.warn?.(message)
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
      const names = tools.schemas(agent).map(schema => schema.name)
      const surface = classifyOfficialSurface(names, config)
      const missing = FILE_TOOLS.map(publicToolName).filter(tool => !names.includes(tool))
      for (const tool of surface.hidden) {
        const replacement = OFFICIAL_REPLACEMENTS[tool]
        if (!names.includes(replacement)) missing.push(`${tool} -> ${replacement}`)
      }
      const diagnostics = [
        ...apiError.length ? [`missing host API: ${apiError.join(', ')}`] : [],
        ...entry.cleanupError ? [entry.cleanupError] : [],
        ...missing.length ? [`missing OPS surface: ${[...new Set(missing)].join(', ')}`] : [],
      ]
      const failure = diagnostics.length ? blocked(diagnostics.join('; '))
        : surface.explicitUnsupported.length ? explicitBlocked(surface.explicitUnsupported) : undefined
      // A failed plan hides nothing: no partial mask over an unready scope.
      return { deny: failure ? [] : surface.hidden, warning: surfaceWarning(surface), failure }
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
          const plan = prepare(agent, entry)
          entry.warning = plan.warning
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
          if (entry.warning !== entry.reportedWarning) {
            if (entry.warning) warn(entry.warning)
            entry.reportedWarning = entry.warning
          }
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
        ?? (hideable(exec.name) ? blocked(`official tool ${exec.name} is hidden by the shell/file/ptc takeover`) : undefined)
    }
    ctx.on('tools/pre-execute', (exec, next) => {
      const reason = refusal(exec)
      return reason ? { kind: 'deny', reason, info: { code: 'READINESS_BLOCKED' } } : next()
    })
    if (typeof tools.guard === 'function') ctx.effect(() => ctx.tools.guard(refusal), 'dsh-ops: strict surface guard')
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
    }, 'dsh-ops: strict official-tool restrictions')
    for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
    if (apiError.length) fail(blocked(`missing host API: ${apiError.join(', ')}`))
  })
}
