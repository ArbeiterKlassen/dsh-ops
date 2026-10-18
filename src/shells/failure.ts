/** Add retry/effect facts without changing the host Bash string error contract. */
import type { OpsErrorPayload } from '../kernel/outcome.js'
import type { ShellResult } from './types.js'

export function bashFailure(value: ShellResult, effectState: 'none' | 'unknown'): OpsErrorPayload {
  const message = value.error ?? value.restriction?.message ?? value.permission?.message
    ?? (value.timedOut ? 'Command timed out.' : value.cancelled ? 'Command cancelled.' : `Command exited with ${value.exitCode ?? value.signal ?? 'unknown status'}.`)
  const argument = message.startsWith('INVALID_BASH_ARGUMENT:')
  const code = argument ? 'INVALID_BASH_ARGUMENT' : value.timedOut ? 'TIMEOUT' : value.cancelled ? 'CANCELLED'
    : value.restriction?.code ?? value.permission?.code ?? (/^([A-Z][A-Z_]+):/.exec(message)?.[1]) ?? 'COMMAND_FAILED'
  return { code, message, effectState, retry: argument && effectState === 'none' ? 'after-input-change' : 'never',
    nextAction: effectState === 'unknown' ? 'Do not repeat the command. Inspect its effects with a read-only operation first.'
      : argument ? 'Correct the named argument before submitting another call.'
        : 'No command effects were applied. Resolve the reported authority or runtime condition before another call; do not bypass a rejection.' }
}
