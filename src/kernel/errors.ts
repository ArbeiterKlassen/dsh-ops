import type { EffectState, FailureStatus, RetryPolicy } from './outcome.js'

export interface ErrorPolicy { readonly status: FailureStatus, readonly retry: RetryPolicy }
const policy = (status: FailureStatus, retry: RetryPolicy): ErrorPolicy => Object.freeze({ status, retry })
const rejected = policy('rejected', 'never')
const invalid = policy('error', 'after-input-change')
const changed = policy('error', 'after-state-change')
const settled = policy('error', 'never')
const unknown = policy('unknown', 'never')

/** Stable native/host codes retain their spelling. This table does not change current wire errors. */
export const ERROR_POLICIES: Readonly<Record<string, ErrorPolicy>> = Object.freeze({
  POLICY_DENIED: rejected,
  CREDENTIAL_DENIED: rejected,
  PATH_RESTRICTED: rejected,
  REVISION_CONFLICT: policy('conflict', 'after-state-change'),
  INVALID_ARGUMENT: invalid,
  EDIT_CONFLICT: invalid,
  SEARCH_STALE: invalid,
  NOT_FOUND: invalid,
  IS_DIRECTORY: invalid,
  OUTPUT_LIMIT: invalid,
  CROSS_DEVICE: invalid,
  ERR_INVALID_ENCODING: invalid,
  TABLE_PARSE_ERROR: invalid,
  FILE_CHANGED: changed,
  REFERENCE_EXPIRED: changed,
  AUTHORITY_CHANGED: changed,
  ACCESS_DENIED: changed,
  EXECUTOR_UNAVAILABLE: changed,
  JOB_BUSY: policy('error', 'bounded-transient'),
  CALL_LIMIT: policy('error', 'after-state-change'),
  CANCELLED: settled,
  METADATA_UNSUPPORTED: settled,
  IO_ERROR: settled,
  SYNC_FAILED: settled,
  CLEANUP_FAILED: settled,
  RESULT_PARTIAL: settled,
  EXECUTION_RESTRICTED: unknown,
  RESULT_UNKNOWN: unknown,
})

/** Effects dominate retry advice: a failed receipt never licenses replaying a possible write. */
export function errorPolicy(code: string, effectState: EffectState = 'none'): ErrorPolicy {
  if (effectState === 'unknown' || code === 'RESULT_UNKNOWN' || code === 'EXECUTION_RESTRICTED') return unknown
  if (effectState !== 'none') return settled
  return Object.hasOwn(ERROR_POLICIES, code) ? ERROR_POLICIES[code]! : settled
}
