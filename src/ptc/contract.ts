/** Existing host adapter over the shared capability catalogue. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { publicToolName } from '../policy.js'
import type { PtcToolName } from '../capabilities/registry.js'
import { PARAMETERS, DESCRIPTIONS, OUTPUT } from '../capabilities/ptc.js'
export { PTC_TOOLS } from '../capabilities/registry.js'
export { PARAMETERS, DESCRIPTIONS, OUTPUT }
export const PTC_SECTION = 'dsh-ops:repository-tooling:ptc'
export function definition(tool: PtcToolName, execute: ToolDefinition['execute']): ToolDefinition {
  return { name: publicToolName(tool), description: DESCRIPTIONS[tool], parameters: PARAMETERS[tool],
    timeoutMs: 300000,
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}
