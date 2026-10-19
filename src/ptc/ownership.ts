import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
interface Row { scope?: object; changed(): void }
interface State { rows: Row[]; agents: Set<Agent>; publishing: number }
const roots = new WeakMap<object, State>()
/** The nearest plugin row owns the SDK; overlapping rows never double-register one layer. */
export async function ownPtcScopes(ctx: Context, changed: () => void) {
  const { scopeOf, scopeChainOf } = await import('@deepseek-ai/dsh-scope')
  const key = ctx.root ?? ctx
  let state = roots.get(key)
  if (!state) { state = { rows: [], agents: new Set(), publishing: 0 }; roots.set(key, state) }
  const shared = state, row: Row = { scope: scopeOf(ctx), changed }
  shared.rows.push(row)
  const notify = () => {
    ++shared.publishing
    try { for (const owner of shared.rows) owner.changed() } finally { --shared.publishing }
  }
  const owns = (agent: Agent): boolean => {
    for (const scope of [...scopeChainOf(agent), undefined]) {
      const matching = shared.rows.filter(candidate => candidate.scope === scope)
      // Last mounted row wins only within the same explicit scope; unload restores the previous row.
      if (matching.length) return matching.at(-1) === row
    }
    return false
  }
  // Call refresh after the caller has installed its ownership handle.
  return { owns, refresh: notify, publishing: () => shared.publishing > 0,
    begin: () => { ++shared.publishing }, end: () => { --shared.publishing },
    changedBelow: () => {
      for (const owner of shared.rows) if (owner !== row && owner.scope && owner.scope !== row.scope
        && (!row.scope || scopeChainOf(owner.scope).includes(row.scope))) owner.changed()
    }, agents: () => [...shared.agents],
    track: (agent: Agent) => { shared.agents.add(agent) },
    forget: (agent: Agent) => { shared.agents.delete(agent) },
    dispose: () => { shared.rows.splice(shared.rows.indexOf(row), 1); notify(); if (!shared.rows.length) roots.delete(key) },
  }
}
