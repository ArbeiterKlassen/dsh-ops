/** Shared DSH permission vocabulary. Model inputs never select an authority mode. */
export const MODES = ['read-only', 'workspace-write', 'danger-full-access']
export function permissionError(policy, operation, required = 'workspace-write', message = '', nextAction) {
  return {
    code: 'POLICY_DENIED', phase: 'preflight', retryable: false, effectState: 'none',
    permission: { current: policy.mode, required, operation, workspaceRoot: policy.workspaceRoot },
    message: `User authorization does not permit ${operation} in DSH mode ${policy.mode}. ${message}`.trim(),
    nextAction: nextAction ?? `Ask the user to change the DSH permission selector to ${required}. Do not retry, change directories, or bypass the sandbox.`,
  }
}
export function denied(policy, operation, required, message, nextAction) {
  return { status: 'rejected', error: permissionError(policy, operation, required, message, nextAction), sandbox: { mode: policy.mode } }
}
