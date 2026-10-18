import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Context } from '@deepseek-ai/cordis'
import { NativeFileTools } from '../../src/file/runtime.js'
import { resolveWorker, tryResolveWorker } from '../../src/ptc/runtime.js'
declare const ctx: Context
const runtime = new NativeFileTools({ ctx, config: { workerPath: '/worker', toolCallTimeoutMs: 30000 } })
void runtime.definition('table_read')
void runtime.definition('result')
// @ts-expect-error Native definitions cannot expose batch-only APIs.
void runtime.definition('batch')
// @ts-expect-error Timeout configuration is numeric, not an unvalidated string.
void new NativeFileTools({ ctx, config: { toolCallTimeoutMs: '30000' } })
// @ts-expect-error An explicit worker path must be a string.
void resolveWorker({ binaryPath: 3 })
const selected = tryResolveWorker({}, { platform: 'linux', arch: 'x64' })
if (selected.ok) {
  const file: string = selected.file
  // @ts-expect-error Failure detail is unavailable on a successful resolution.
  void selected.reason
  void file
} else {
  const reason: string = selected.reason
  // @ts-expect-error A failed resolution cannot provide a worker path.
  void selected.file
  void reason
}

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { invoke as fileCall, failure as fileFailure } from '../../src/file/worker.js'
declare const exec: ToolRunContext
const nativeValue: unknown = await fileCall(ctx, '/worker', 'stat', { path: 'safe' }, exec, undefined, { denyCredentialReads: true })
// @ts-expect-error The transport result must be narrowed before accessing canonical fields.
void nativeValue.status
// @ts-expect-error A worker executable path cannot be a number.
void fileCall(ctx, 3, 'stat', {}, exec)
// @ts-expect-error Credential policy configuration is boolean.
void fileCall(ctx, '/worker', 'stat', {}, exec, undefined, { denyCredentialReads: 'true' })
// @ts-expect-error Effect state must be an explicit kernel fact.
void fileFailure('RESULT_UNKNOWN', 'lost output', 'execute', 'success')
