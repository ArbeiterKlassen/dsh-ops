import type { Context } from '@deepseek-ai/cordis'
import { applyComponent } from '../../index.js'
import { mountRuntimeSettings } from '../../settings/runtime-host.js'
import { resolveConfig } from '../../config.js'
import { editable, settingsConfig, configObject } from '../../settings/schema.js'
export const name = 'dsh-ops-bash & host PowerShell'
export const Config = settingsConfig(value => {
  const raw = configObject(value), validated = resolveConfig(raw)
  // Keep raw ordinary keys: applyComponent owns normalization and migration.
  return { ...raw, publishBashTool: validated.publishBashTool }
}, {
  bashPath: editable('string', 'Absolute Bash executor path. Remove the override to select the optional managed installation.'),
  publishBashTool: editable('boolean', 'Publish Bash for authorized sessions.'),
})
export function apply(ctx: Context, config: unknown): void {
  applyComponent(ctx, config, 'shell')
  mountRuntimeSettings(ctx)
}
