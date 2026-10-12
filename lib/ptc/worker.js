/** Native worker bridge. Every execution uses DSH policy, confinement and process governance. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export function resolveWorker(config = {}) {
  const file = config.binaryPath ?? process.env.DSH_OPS_WORKER_BIN
    ?? path.join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('Native worker unavailable; build native/Cargo.toml or configure an absolute binaryPath.')
  return file
}
export function failure(code, message, effectState = 'none') {
  return { status: 'error', error: { code, phase: effectState === 'none' ? 'preflight' : 'execute', retryable: false, effectState,
    nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the persistent job manifest; never blindly rerun an interrupted batch.', message } }
}
export async function invoke(ctx, file, tool, args, exec, signal) {
  const session = exec?.agent?.session
  if (!session?.id) return failure('POLICY_DENIED', 'An authoritative session identity is required.')
  const policyService = ctx.get('sandboxPolicy'), subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  const jobId = tool === 'batch' ? (args?.action === 'run' || args?.action === 'plan' ? `j-${randomUUID()}` : args?.id) : undefined
  const errorResult = (code, message, effect = 'none') => ({ ...failure(code, message, effect), ...(jobId ? { detailsRef: jobId } : {}) })
  let policy, confined, spawned = false
  try {
    policy = policyService.resolve({ session })
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
      || !path.isAbsolute(policy?.workspaceRoot ?? '')) return failure('POLICY_DENIED', 'Invalid authoritative policy.')
    // All calls may journal, including put/page; read-only must not write a local store.
    if (policy.mode === 'read-only') return failure('POLICY_DENIED', 'This component requires workspace-write for persistent results/audit; no automatic escalation.')
    const input = JSON.stringify({ root: policy.workspaceRoot, scope: String(session.id), tool, args, ...(jobId ? { job_id: jobId } : {}) })
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (!sandbox?.confine) return failure('SANDBOX_UNAVAILABLE', 'No DSH process confinement provider; refusing unconfined execution.')
      confined = await sandbox.confine(argv, policy, signal)
      if (confined?.enforcement !== 'full' || !Array.isArray(confined.argv) || !confined.argv.length) {
        return failure('SANDBOX_UNAVAILABLE', 'Full file-effect confinement is required; partial enforcement is not accepted.')
      }
      argv = confined.argv
    }
    signal.throwIfAborted()
    // Authority may change during asynchronous sandbox preparation.
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) return failure('POLICY_DENIED', 'Authority changed during preparation.')
    const handle = subprocess.spawn({ argv, cwd: policy.workspaceRoot,
      stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 1000, signal })
    spawned = true
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0)
    if (signal.aborted || outcome.signal) return errorResult('RESULT_UNKNOWN', 'Worker interrupted; durable write-ahead records preserve possible effects.', 'unknown')
    if (confined && runnerFailure(outcome.exitCode, stderr.text, confined.runnerFailureRules ?? [])) {
      return failure('SANDBOX_UNAVAILABLE', 'DSH confinement runner failed before executing the worker.')
    }
    if (stdout.lossy) return errorResult('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts remain in the audit store.', 'unknown')
    if (outcome.exitCode !== 0) {
      const denied = confined?.denialSignatures?.some(s => stderr.text.toLowerCase().includes(s.toLowerCase()))
      return errorResult(denied ? 'POLICY_DENIED' : 'RESULT_UNKNOWN', 'Worker did not return a settled result; inspect audit records.', 'unknown')
    }
    let value
    try { value = JSON.parse(stdout.text) } catch { return errorResult('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect audit records.', 'unknown') }
    return { ...value, ...(value.status === 'error' && jobId ? { detailsRef: jobId } : {}), sandbox: { mode: policy.mode, ...(confined ? { enforcement: confined.enforcement } : {}) } }
  } catch (error) {
    return errorResult(spawned ? 'RESULT_UNKNOWN' : error?.code === 'SANDBOX_UNAVAILABLE' ? 'SANDBOX_UNAVAILABLE' : 'EXECUTOR_UNAVAILABLE',
      String(error?.message ?? error), spawned ? 'unknown' : 'none')
  }
}
function runnerFailure(exitCode, stderr, rules) {
  if (exitCode === 0 || exitCode == null) return false
  return rules.some(rule => (!rule.allowedExitCodes || rule.allowedExitCodes.includes(exitCode))
    && stderr.split(/\r?\n/).some(line => !(rule.informationalLines ?? []).some(s => s.toLowerCase() === line.toLowerCase())
      && (rule.fatalSignatures ?? []).some(s => line.toLowerCase().includes(s.toLowerCase()))))
}
