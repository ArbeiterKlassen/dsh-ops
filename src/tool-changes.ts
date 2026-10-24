/** Synchronous attribution for package-owned tool notifications; never patches host services. */
let changing: readonly object[] | undefined
export function toolChangeScopes(): readonly object[] | undefined { return changing }
export function withToolChange<T>(scopes: readonly object[], action: () => T): T {
  const previous = changing
  changing = previous === undefined ? scopes : previous.length && scopes.length ? [...previous, ...scopes] : []
  try { return action() } finally { changing = previous }
}
