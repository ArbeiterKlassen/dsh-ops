/** Inspect public presentation before publishing a replacement. This result is
 * only a boolean; the inspected assembly never becomes a provider request. */
import type { AssembleContext, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

const probes = new WeakSet<AssembleContext>()
export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }
export async function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>): Promise<boolean> {
  const context: AssembleContext = { scope }
  probes.add(context)
  try {
    const assembly = await prompt.assemble(context)
    return !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
  } finally { probes.delete(context) }
}
