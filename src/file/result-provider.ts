/** Exact visible OPS registrations supply Native projections; no shared registry mutation. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
interface Host { root?: object; emit?(name: 'tools/change'): unknown; get(name: 'tools'): { get(name: string, scope?: unknown): ToolDefinition | undefined } | undefined }
interface Provider { definition: ToolDefinition; scope: unknown; active: boolean; publish(visible: boolean): void }
interface State { providers: Set<Provider>; ptc: Set<unknown> }
const owners = new WeakMap<object, State>()
function state(ctx: Host): State {
  const key = ctx.root ?? ctx
  let entry = owners.get(key)
  if (!entry) { entry = { providers: new Set(), ptc: new Set() }; owners.set(key, entry) }
  return entry
}
export async function registerNativeProvider(ctx: Host, definitions: ToolDefinition[], register: (tool: ToolDefinition) => (() => void)): Promise<() => void> {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  const owner = state(ctx), scope = scopeOf(ctx as Context)
  const providers = definitions.map(definition => {
    let dispose: (() => void) | undefined
    const provider: Provider = { definition, scope, active: true, publish(visible) {
      if (visible && provider.active && !dispose) dispose = register(definition)
      else if (!visible && dispose) { const remove = dispose; dispose = undefined; remove() }
    } }
    owner.providers.add(provider)
    return provider
  })
  const stop = () => {
    const errors: unknown[] = []
    for (const provider of providers) {
      provider.active = false; owner.providers.delete(provider)
      try { provider.publish(false) } catch (error) { errors.push(error) }
    }
    ctx.emit?.('tools/change')
    if (errors.length) throw new AggregateError(errors, 'Native provider teardown failed')
  }
  try { if (!owner.ptc.has(scope)) for (const provider of providers) provider.publish(true) }
  catch (error) { stop(); throw error }
  ctx.emit?.('tools/change')
  return stop
}
/** Yield only this plugin's registrations in the exact layer being claimed. */
export function claimPtcSurface(ctx: Host, scope: unknown): () => void {
  const owner = state(ctx)
  owner.ptc.add(scope)
  for (const provider of owner.providers) if (provider.scope === scope) provider.publish(false)
  return () => {
    owner.ptc.delete(scope)
    for (const provider of owner.providers) if (provider.scope === scope) provider.publish(true)
  }
}
/** Capture before publishing PTC: external restrictions and sibling scopes remain authoritative. */
export function nativeProviders(ctx: Host, scope: unknown): Provider[] {
  const tools = ctx.get('tools')
  return [...state(ctx).providers].filter(provider => provider.active && tools?.get(provider.definition.name, scope) === provider.definition)
}
