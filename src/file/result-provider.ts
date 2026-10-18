/** Only exact visible OPS registrations can supply a scope's Native pager. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
interface Host {
  root?: object
  get(name: 'tools'): { get(name: string, scope?: unknown): ToolDefinition | undefined } | undefined
}
interface Provider { definition: ToolDefinition; probes: ToolDefinition[]; scope: unknown; active: boolean; publish(visible: boolean): void }
interface State { providers: Set<Provider>; ptc: Set<unknown> }
const owners = new WeakMap<object, State>()
function state(ctx: Host): State {
  const key = ctx.root ?? ctx
  let entry = owners.get(key)
  if (!entry) { entry = { providers: new Set(), ptc: new Set() }; owners.set(key, entry) }
  return entry
}
export async function registerResultProvider(ctx: Host, definition: ToolDefinition, probes: ToolDefinition[],
  register: () => (() => void)): Promise<() => void> {
  // Public pinned scope API loaded only during activation, never by the package's host entry.
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  const owner = state(ctx), scope = scopeOf(ctx as Context)
  let dispose: (() => void) | undefined
  const provider: Provider = { definition, probes, scope, active: true, publish(visible) {
    if (visible && provider.active && !dispose) dispose = register()
    else if (!visible && dispose) { const remove = dispose; dispose = undefined; remove() }
  } }
  owner.providers.add(provider)
  try { if (!owner.ptc.has(scope)) provider.publish(true) }
  catch (error) { provider.active = false; owner.providers.delete(provider); throw error }
  return () => { provider.active = false; owner.providers.delete(provider); provider.publish(false) }
}
/** Only a PTC definition in this exact registration layer may temporarily replace its Native peer. */
export function claimPtcResult(ctx: Host, scope: unknown): () => void {
  const owner = state(ctx)
  owner.ptc.add(scope)
  for (const provider of owner.providers) if (provider.scope === scope) provider.publish(false)
  return () => {
    owner.ptc.delete(scope)
    for (const provider of owner.providers) if (provider.scope === scope) provider.publish(true)
  }
}
export function nativeResultProvider(ctx: Host, scope: unknown): Provider | undefined {
  const tools = ctx.get('tools')
  const visible = [...state(ctx).providers].filter(provider => provider.active
    && (tools?.get(provider.definition.name, scope) === provider.definition
      || provider.probes.some(definition => tools?.get(definition.name, scope) === definition)))
  // Fully masked or ambiguous file rows fail closed; never borrow a sibling's executor.
  return visible.length === 1 ? visible[0] : undefined
}
