import { apply, resolveHidingConfig } from '../../official-tool-hiding.js'
export const name = 'dsh-ops-hide-official'
export { apply }

// Cordis consumes StandardSchemaV1 directly. No host value import is needed.
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-ops',
    validate(value: unknown) {
      try { return { value: resolveHidingConfig(value) } }
      catch (error) { return { issues: [{ message: error instanceof Error ? error.message : String(error) }] } }
    },
  },
}
