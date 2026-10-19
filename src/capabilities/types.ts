import type { JsonSchemaNode, ObjectJsonSchema, ToolPresentationMode } from '@deepseek-ai/dsh-tools'

export type Component = 'file' | 'ptc' | 'shell'
export type ParameterSchema = ObjectJsonSchema & Record<string, unknown> & {
  properties: Record<string, JsonSchemaNode>
  required: string[]
}

/** Availability describes today's registrations; discovery changes it in a later slice. */
export interface CapabilityMetadata {
  readonly rawName: string
  readonly component: Component
  readonly presentations: readonly ToolPresentationMode[]
  readonly availability: 'resident'
  /** Conservative per-tool flag: some actions (batch plan/result page) remain read-only. */
  readonly mutates: boolean
  readonly concurrencySafe: boolean
}

export interface SchemaCapability extends CapabilityMetadata {
  readonly parameters: ParameterSchema
  readonly description: string
  readonly output: JsonSchemaNode
  readonly nativeProjection?: { readonly component: 'file'; readonly parameters: ParameterSchema; readonly description: string }
}
