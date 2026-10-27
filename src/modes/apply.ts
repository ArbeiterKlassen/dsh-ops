/**
 * Apply one enhanced-preset mode row.
 *
 * Each row is self-contained: it registers its mode in the shared registry, then
 * publishes only for Agents composed from its preset. The native file surface is
 * registered per Agent, the Windows shell layer and the PTC SDK are gated by the
 * same preset test, and the replacement controller hides only official tools
 * whose OPS counterpart is visible. Compatibility mode is a runtime switch that
 * lifts those hides without unloading any row.
 */
import type { Context } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import { apply as mountPtc } from '../ptc/index.js'
import { mountSessionBash, type BashGate } from '../session-shells.js'
import { resolveShells } from '../shells.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { resolveModeConfig, type ModeConfig } from './config.js'
import { modeOf } from './detect.js'
import { mountNativeMode } from './native.js'
import { MODE_PLANS } from './plan.js'
import { joinMode, onModesChange } from './registry.js'
import { mountReplacements } from './replacements.js'
import type { ModeId } from './types.js'

/**
 * Mount one enhanced preset mode.
 * @param root - the mode row's context.
 * @param rawConfig - the loader row's config value.
 * @param mode - the mode the row enables.
 * @returns void; every registration is disposed with the row.
 */
export function applyMode(root: Context, rawConfig: unknown, mode: ModeId): void {
  const config: ModeConfig = resolveModeConfig(rawConfig)
  const plan = MODE_PLANS[mode]
  const leave = joinMode(root, mode, config)
  root.effect(() => () => leave(), `dsh-ops: ${mode} mode switch`)
  const matches = (agent: Agent): boolean => modeOf(root, agent) === mode
  const watch = (notify: () => void): (() => void) => onModesChange(root, notify)
  // The Windows shell replacement is the only shell work a mode row performs:
  // POSIX sessions already run the host's bash, so OPS publishes nothing there.
  if (plan.shell && process.platform === 'win32') {
    mountWorkspacePreparation(root)
    const gate: BashGate = { allows: matches, watch }
    const shells = resolveShells(config)
    root.inject(['tools'], ctx => { mountSessionBash(ctx, config, shells, gate) })
  }
  mountReplacements(root, config, mode)
  if (plan.nativeFiles) mountNativeMode(root, config, mode)
  if (plan.ptc) {
    mountPtc(root, {
      binaryPath: config.binaryPath, required: config.required,
      allowedTools: config.allowedTools, alwaysLoaded: config.alwaysLoaded,
    }, { allows: matches, watch })
  }
}
