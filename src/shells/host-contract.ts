// Adapted from @deepseek-ai/dsh-tool-bash 0.2.0-rc.2 (MIT). See licenses/deepseek-harness/LICENSE.
/** DSH 0.2.0-rc.2 shell DTO and rendering, with explicit OPS compatibility fields. */
import type { JsonSchemaNode, JsonSchemaType } from '@deepseek-ai/dsh-tools'
import type { ShellResult, HostForeground, HostBashResult } from './types.js'
import { BASH_OUTPUT_SCHEMA, renderBashResult, withBashStatus } from './tool.js'

const nullable = (type: JsonSchemaType): JsonSchemaNode => ({ oneOf: [{ type }, { type: 'null' }] })
export const HOST_BASH_OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'jobId'], properties: {
      kind: { type: 'string', const: 'background' }, jobId: { type: 'string' },
    } },
    { type: 'object', additionalProperties: false, required: ['kind', 'jobId', 'timeoutMs', 'output'], properties: {
      kind: { type: 'string', const: 'promoted' }, jobId: { type: 'string' }, timeoutMs: { type: 'number' }, output: { type: 'string' },
    } },
    { ...BASH_OUTPUT_SCHEMA, required: [...(BASH_OUTPUT_SCHEMA.required ?? []), 'kind', 'exitCode', 'signal', 'aborted'], properties: {
      ...BASH_OUTPUT_SCHEMA.properties,
      kind: { type: 'string', const: 'foreground' }, exitCode: nullable('integer'), signal: nullable('string'),
      aborted: { type: 'boolean' }, stopped: { type: 'string' },
    } },
  ],
}

export function hostForeground(value: ShellResult): HostForeground {
  return { ...withBashStatus(value), kind: 'foreground', exitCode: value.exitCode ?? null,
    signal: value.signal ?? null, aborted: value.cancelled === true }
}

export function hostFailure(message: string, timeoutMs = 120_000) {
  return hostForeground({ error: message, timedOut: false, timeoutMs,
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
}

export function renderHostBash(value: HostBashResult): string {
  if (value.kind === 'background') return `started background job ${value.jobId}`
  if (value.kind === 'promoted') return `${value.output || '(no output)'}\n[still running after ${value.timeoutMs}ms; moved to background job ${value.jobId}]\nUse job_output to collect output and job_kill to stop the command.`
  const { exitCode, signal, ...rest } = value
  const body = renderBashResult(rest)
  const markers = []
  if (value.sandbox?.denied) markers.push(`[sandbox: file access denied under ${value.sandbox.mode} mode]`)
  if (value.stopped) markers.push(`[stopped: ${value.stopped}]`)
  if (signal !== null) markers.push(`[killed by signal: ${signal}]`)
  if (exitCode !== null) markers.push(`[exit code: ${exitCode}]`)
  return [body, ...markers].join('\n')
}
