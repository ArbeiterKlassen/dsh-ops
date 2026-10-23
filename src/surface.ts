/** The tool-name surface a presentation probe reads, shared by both PTC rows. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type ToolRuntime from '@deepseek-ai/dsh-tools'

/**
 * Visible tool names of one agent, the surface a presentation probe reads.
 *
 * Names alone decide the probe: a `ptcOnly`/`native` verdict asks which tools the
 * scope publishes and whether `run_code` is the only one, so a definition swapped
 * for an equal name cannot flip it. Reading definitions as well would cost one
 * `tools.get` per name, and each of those rebuilds the whole scope view.
 * @param tools - the tool registry.
 * @param agent - the scope to read.
 * @returns the visible names joined by NUL, usable as a memo key.
 */
export const surfaceOf = (tools: Pick<ToolRuntime, 'schemas'>, agent: Agent): string =>
  tools.schemas(agent).map(schema => schema.name).join('\u0000')
