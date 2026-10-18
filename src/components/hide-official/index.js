import { apply, resolveHidingConfig } from '../../official-tool-hiding.js'
export const name = 'dsh-ops-hide-official'
export { apply }

// Cordis consumes StandardSchemaV1 directly. No host value import is needed.
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ops',
    validate(value) {
      try { return { value: resolveHidingConfig(value) } }
      catch (error) { return { issues: [{ message: error.message }] } }
    },
  },
}
