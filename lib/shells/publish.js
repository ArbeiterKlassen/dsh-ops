/**
 * Publishing the tools that run on the plugin's own shells, and the remedies a
 * spawn failure deserves.
 *
 * Contract: {@link publishShellTools} is called inside one `ctx.effect` during
 * mount and returns the disposer for whatever tool registrations it made
 * (today: the `ops_bash` tool backed by the plugin's own bash). Returning a
 * no-op disposer is valid.
 *
 * Why L2 publishes a tool instead of configuring an executor: `bash-local` has
 * no executable field (`packages/shell/bash-local/src/index.ts` — its `Config`
 * is `cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/
 * `graceMs` only), so the only zero-internal-dependency way to run the plugin's
 * own bash is to publish `ops_bash` ourselves and execute through
 * `ctx.subprocess`. L3 needs no tool: `pwsh-sandbox` inherits `pwshPath`
 * verbatim (`packages/shell/pwsh-sandbox/src/index.ts:40`,
 * `type Config = LocalConfig`), so `cordis.patch.yml` points that row at the
 * executable `lib/shells/paths.js` resolves — provisioned copy first, bundled
 * layouts after it, in the order `lib/shells/paths.js`'s `PWSH_LAYOUT_ORDER`
 * names. That is also why L3 has no `available` beyond "the executable is
 * there": the rung and the host row are the same fact, and a config key could
 * not reach the row anyway (a bundle patch is evaluated before this plugin's own
 * row is mounted).
 *
 * A rung that is unavailable publishes nothing and reports why through the
 * context logger; it never throws, because a deployment without bash must still
 * load this plugin.
 *
 * @module dsh-ops/shells/publish
 */

import { BASH_TOOL_NAME } from './constants.js'
import { GENERIC_BASH_REMEDY } from './paths.js'
import { bashToolDefinition } from './tool.js'

/**
 * The one remedy two rungs share: the machine's own bash is not a registry
 * artifact, so "fetch it from the registry" is not the advice it needs.
 */
const SYSTEM_BASH_SPAWN_REMEDY = 'The system bash this deployment fell back to is gone; '
  + 'reinstall it, or run `dsh-ops provision-shells --bash` for a copy the registry cannot take away.'

/**
 * The remedy one ENOENT deserves, chosen by where the executable came from.
 *
 * All of these are "the file was there when the rung resolved and is gone now",
 * but they are restored by different actions: `bundled` by the profile's own
 * dependencies, `provisioned` by running the provisioner again, `config` by the
 * operator fixing the path they typed, and `path`/`well-known` by the machine's
 * own bash. The single sentence this replaced told all of them to repair the
 * profile installation, so most were sent somewhere that could not help.
 * @type {Readonly<Record<string, string>>}
 */
const BASH_SPAWN_REMEDY = Object.freeze({
  bundled: "The bundled bash left the profile after it was resolved; restore the profile's "
    + 'dependencies, or run `dsh-ops provision-shells --bash` to fetch the pinned copy from '
    + 'upstream releases instead.',
  provisioned: 'The provisioned copy under this DSH_HOME is gone; run '
    + '`dsh-ops provision-shells --bash` again to reinstall the pinned upstream copy.',
  config: 'The configured bashPath no longer exists; point bashPath at a real executable, or '
    + 'clear it and run `dsh-ops provision-shells --bash`.',
  path: SYSTEM_BASH_SPAWN_REMEDY,
  'well-known': SYSTEM_BASH_SPAWN_REMEDY,
})

/**
 * The remedy for a source this table has never seen (D8).
 *
 * `source` is a closed set today, but it is a string that reaches here from the
 * resolution: a future rung must degrade to a line that is still actionable
 * rather than to no advice at all, and it must not throw on the way.
 */
const DEFAULT_BASH_SPAWN_REMEDY = `${GENERIC_BASH_REMEDY}.`

/**
 * Convert an infrastructure spawn failure into a concise model-facing result.
 *
 * Only ENOENT is source-routed: it is the one failure that means "this exact
 * executable vanished", and what to do about it depends entirely on which rung
 * supplied it. Every other spawn failure keeps the plain message, because the
 * rung is not the interesting part of it.
 * @param {unknown} error - the failure `ctx.subprocess.spawn` raised.
 * @param {string} file - the executable the rung resolved.
 * @param {string} source - where that executable came from.
 * @returns {string} the model-facing error text.
 */
export function formatBashSpawnError(error, file, source) {
  const code = typeof error?.code === 'string' ? ` (${error.code})` : ''
  if (error?.code === 'ENOENT') {
    const remedy = Object.hasOwn(BASH_SPAWN_REMEDY, source)
      ? BASH_SPAWN_REMEDY[source]
      : DEFAULT_BASH_SPAWN_REMEDY
    return `bash executable is unavailable${code}: ${file}. ${remedy}`
  }
  return `bash could not be started${code}: ${String(error?.message ?? error)}`
}

/**
 * Report one load-time shell problem without letting a hostile logger hide it.
 * @param {object} ctx - a Cordis context.
 * @param {string} message - the report.
 * @returns {void}
 */
function reportShellProblem(ctx, message) {
  const logger = ctx?.logger
  if (typeof logger?.warn === 'function') {
    logger.warn(message)
    return
  }
  if (typeof logger?.error === 'function') {
    logger.error(message)
    return
  }
  console.warn(message)
}

/**
 * Publish the tools that run on the plugin's own shells.
 *
 * Today that is exactly one tool — `ops_bash`, bound to the resolved bash — and
 * nothing else: pwsh needs no tool, because the host's `pwsh-sandbox` row runs
 * the plugin's own executable whenever the bundle override resolved one. A rung
 * that is unavailable publishes nothing and reports why through the context
 * logger; it never throws, because a deployment without bash must still load
 * this plugin.
 * @param {object} ctx - a Cordis context carrying the tool registry.
 * @param {import('./config.js').ResolvedConfig} config - the plugin configuration.
 * @param {{bash: ShellResolution, pwsh: ShellResolution}} shells - the resolution to publish for.
 * @returns {() => void} the disposer for every registration made here.
 */
export function publishShellTools(ctx, config, shells) {
  if (config?.publishBashTool === false) return () => {}
  const bash = shells?.bash
  if (bash === undefined || bash.available !== true || typeof bash.file !== 'string') {
    const reason = bash?.detail ?? 'the bash rung was not resolved'
    reportShellProblem(ctx, `dsh-ops: the plugin's own bash is unavailable (${reason}); `
      + `${BASH_TOOL_NAME} is not published.`)
    return () => {}
  }

  const registry = ctx?.get?.('tools')
  if (registry === undefined || typeof registry.register !== 'function') {
    reportShellProblem(ctx, `dsh-ops: no tool registry (ctx.tools) is mounted; `
      + `${BASH_TOOL_NAME} was not published.`)
    return () => {}
  }
  // Reaching the host service through `ctx.get` keeps this module free of any
  // `@deepseek-ai/*` value import while still running every command through the
  // harness's own credential scrub and process governance.
  //
  // This check gates the REGISTRATION, not just the call: without the
  // subprocess service the tool could be published and then fail on every
  // invocation, and a deployment whose ladder advertises rung two for a tool
  // that cannot run is worse than one that admits the rung is missing.
  const subprocess = ctx?.get?.('subprocess')
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    reportShellProblem(ctx, `dsh-ops: no subprocess service (ctx.subprocess) is mounted, so the `
      + `resolved bash (${bash.source}) cannot be run; ${BASH_TOOL_NAME} is not published.`)
    return () => {}
  }

  let dispose
  try {
    dispose = registry.register(bashToolDefinition({ file: bash.file, source: bash.source, subprocess }))
  } catch (error) {
    // A registry conflict (a foreign `ops_bash`) or a schema rejection is
    // reported and skipped: it must not fail plugin activation.
    reportShellProblem(ctx, `dsh-ops: ${BASH_TOOL_NAME} could not be registered `
      + `(${String(error?.message ?? error)}).`)
    return () => {}
  }
  if (typeof dispose !== 'function') return () => {}
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    dispose()
  }
}
