/** Update configuration modification area.
 * Append migrations here; never spread upgrade write-back across components.
 * Markers belong to each owning config row, not a machine-global sentinel.
 */
import { LEGACY_FASTCTX_KEYS } from './config.js'

export const CONFIG_UPDATE_VERSION = 2

/** Apply every pending step in order; each step runs exactly once per row. */
export function updatedConfig(raw = {}, disableEvaluatedFallback = false) {
  const version = Number.isSafeInteger(raw?.configUpdateVersion) ? raw.configUpdateVersion : 0
  if (version >= CONFIG_UPDATE_VERSION) return raw
  const next = { ...raw }
  // 1 (0.2.5): retire the old implicit system-bash opt-in. Later manual opt-ins are kept.
  if (version < 1 && (raw?.allowSystemShellFallback === true || disableEvaluatedFallback)) next.allowSystemShellFallback = false
  // 2: drop the keys only the removed FastCtx surface read.
  if (version < 2) for (const key of LEGACY_FASTCTX_KEYS) delete next[key]
  next.configUpdateVersion = CONFIG_UPDATE_VERSION
  return next
}

// `dsh-ops/background` is a no-op stub that reads no config, so it needs no migration.
const OWN_NAMES = new Set(['dsh-ops', 'dsh-ops/shell', 'dsh-ops/file'])
const pending = new WeakSet()

/** Save only this component's raw owning row via the public loader lifecycle.
 * Runtime migration happens synchronously in apply before any executor resolves.
 * Write-back is deferred so Entry._init has assigned its owning fiber first.
 * Raw expressions/unrelated fields are preserved rather than serializing the
 * interpolated runtime config. The owning raw row is updated directly and the
 * tree write is scheduled; deliberately do not call Entry.update(), because
 * that needlessly remounts the plugin while the profile is loading and makes
 * every component migration compete with desktop profile reload.
 */
export function mountConfigUpdates(ctx, raw) {
  if ((raw?.configUpdateVersion ?? 0) >= CONFIG_UPDATE_VERSION) return
  const entry = ctx.fiber?.entry
  if (!entry || !OWN_NAMES.has(entry.options?.name) || typeof entry.update !== 'function'
    || typeof entry.parent?.tree?.write !== 'function') {
    ctx.logger?.warn?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} applied in memory only; no owning loader row is available for save.`)
    return
  }
  if (pending.has(entry)) return
  pending.add(entry)
  let cancelled = false
  const immediate = setImmediate(() => {
    if (cancelled) { pending.delete(entry); return }
    const previous = entry.options.config ?? {}
    const next = updatedConfig(previous, raw?.allowSystemShellFallback === true)
    if (next === previous) { pending.delete(entry); return }
    // The effective config was already resolved from `updatedConfig()` in
    // applyComponent. Mutating the owning raw row and scheduling its tree write
    // is enough to persist the marker; calling `entry.update()` here would
    // restart this plugin while the profile loader is already mounting it.
    // That restart is especially expensive when several component rows migrate
    // together, and it races the desktop profile's own reload watcher.
    void (async () => {
      try {
        // Re-check cancellation at the deferred write, not only in the scheduler above (#30). The
        // body starts in the same tick as that check, so this cannot change behaviour today; it
        // keeps the guard next to the mutation it protects if the write ever moves behind an await.
        if (cancelled) return
        entry.options.config = next
        const write = entry.parent.tree.write()
        if (write && typeof write.then === 'function') await write
        ctx.logger?.info?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} submitted to the owning loader for persistence; legacy system shell fallback disabled (if previously true) and removed FastCtx keys dropped.`)
      } catch (error) {
        // Do not retain a success marker after a synchronous/returned write
        // failure. Runtime remains confined; the next activation retries.
        if (entry.options.config === next) entry.options.config = previous
        ctx.logger?.warn?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} could not be saved: ${error.message}; runtime fallback remains disabled for this activation.`)
      } finally { pending.delete(entry) }
    })()
  })
  ctx.effect(() => () => { cancelled = true; clearImmediate(immediate); pending.delete(entry) }, 'dsh-ops: pending config update')
}
