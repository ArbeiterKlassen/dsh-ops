import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { publicToolName } from '../policy.js'
import { capability } from '../capabilities/registry.js'
import type { FileToolName } from '../capabilities/registry.js'
import { PARAMETERS, DESCRIPTIONS, OUTPUT } from '../capabilities/file.js'
export { FILE_TOOLS } from '../capabilities/registry.js'
export { PARAMETERS, DESCRIPTIONS, OUTPUT }
type OutputValue = Parameters<ToolDefinition['output']['render']>[1]
const record = (value: OutputValue | undefined): value is Record<string, OutputValue> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Drop unused empty placeholders strict adapters send for optional fields; never mutate the caller's object. */
export function normalizeArguments(rawName: string, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const entry = capability(rawName)
  const schema = entry?.component === 'file' ? entry.parameters : undefined
  if (!schema) return { ...args }
  const required = new Set(schema.required)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const field = schema.properties[key]
    if (field && !required.has(key)) {
      if (field.type === 'string' && typeof value === 'string' && value.trim() === '') continue
      if (field.type === 'array' && Array.isArray(value) && value.length === 0) continue
    }
    result[key] = value
  }
  return result
}

// Compact only homogeneous inspect pages. Keep every non-path field and the
// complete execution value for PTC/program consumers; never mutate worker data.
function modelView(rawName: FileToolName, value: OutputValue): OutputValue {
  if (rawName !== 'inspect_local_file' || !record(value) || value.status !== 'completed' || !Array.isArray(value.items) || value.items.length === 0) return value
  const path = (record(value.items[0]) ? value.items[0].path : undefined)
  if (typeof path !== 'string' || !value.items.every(item => record(item) && item.path === path)) return value
  return { ...value, path, items: value.items.map(item => { const { path: _path, ...rest } = item as Record<string, OutputValue>; return rest }) }
}

export function definition(rawName: FileToolName, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: publicToolName(rawName),
    description: DESCRIPTIONS[rawName],
    parameters: PARAMETERS[rawName],
    ...(capability(rawName)?.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(modelView(rawName, value)) }] },
    execute,
  }
}
