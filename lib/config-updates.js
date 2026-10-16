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

/** Save only this component's raw owning row through the profile config editor.
 *
 * Runtime migration happens synchronously in apply before any executor resolves;
 * this function only records that it ran. The write is submitted through
 * `configEditor.edit()`, which rewrites the **active profile's patch layer** —
 * validating the whole candidate before touching disk, preserving YAML comments
 * and `!!js` expressions outside the replaced value, and serializing with
 * profile changes and HMR.
 *
 * Deliberately **never** `EntryTree.write()` (#91, #108). That API is a
 * whole-composed-tree write-back: it bakes every composed row into the profile
 * root file, which the profile loader documents as an empty entry list that it
 * defensively resets on boot. The stale copy then carries *other* plugins'
 * settings rows — `ui-theme`'s `preference`/`fontSize` above all — so changing
 * the theme or font size echoes the previous value back into the settings scope
 * and the row visibly bounces (dark -> system -> dark). Routing the marker
 * through the patch layer leaves every other row untouched.
 *
 * Errors, and a profile without the editor, degrade to an in-memory migration:
 * the effective config was already derived from `updatedConfig()` in
 * applyComponent, so the runtime stays confined either way and the next
 * activation retries the save.
 */
export function mountConfigUpdates(ctx, raw) {
  if ((raw?.configUpdateVersion ?? 0) >= CONFIG_UPDATE_VERSION) return
  const entry = ctx.fiber?.entry
  if (!entry || !OWN_NAMES.has(entry.options?.name)) {
    ctx.logger?.warn?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} applied in memory only; no owning loader row is available for save.`)
    return
  }
  if (pending.has(entry)) return
  pending.add(entry)
  let cancelled = false
  const immediate = setImmediate(() => {
    if (cancelled) { pending.delete(entry); return }
    void (async () => {
      try {
        const previous = entry.options.config ?? {}
        const next = updatedConfig(previous, raw?.allowSystemShellFallback === true)
        if (next === previous) return
        // Read the service late: this runs after the current mount tick, so a
        // sibling config-editor row mounted later in the same tree is visible.
        const editor = ctx.get?.('configEditor')
        if (typeof editor?.edit !== 'function') {
          ctx.logger?.warn?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} applied in memory only; the profile config editor is unavailable, so the one-time marker is not saved.`)
          return
        }
        // Re-check cancellation at the deferred write, not only in the scheduler above (#30). The
        // migration must not land on a row this activation has already torn down.
        if (cancelled) return
        await editor.edit(entry, () => next)
        ctx.logger?.info?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} saved to the profile patch; legacy system shell fallback disabled (if previously true) and removed FastCtx keys dropped.`)
      } catch (error) {
        // Do not retain a success marker after a failed save. Runtime remains
        // confined; the next activation retries.
        ctx.logger?.warn?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} could not be saved: ${error.message}; the migration stays in effect for this activation only.`)
      } finally { pending.delete(entry) }
    })()
  })
  ctx.effect(() => () => { cancelled = true; clearImmediate(immediate); pending.delete(entry) }, 'dsh-ops: pending config update')
}
