/** One-shot worker transport. Only trusted bridge code supplies envelope metadata and budgets. */
import { randomUUID } from 'node:crypto'

export const WORKER_TIMEOUT_MS = 300000
export const WORKER_OUTPUT_BYTES = 128 * 1024

export function workerEnvelope(component, request, timeoutMs = WORKER_TIMEOUT_MS) {
  timeoutMs ??= WORKER_TIMEOUT_MS
  const timeout = Math.max(1, Math.trunc(timeoutMs))
  if (!['file', 'ptc'].includes(component) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeout > 2147483647) {
    throw new TypeError('Invalid internal worker component or timeout')
  }
  return { version: 1, requestId: randomUUID(), component,
    budget: { timeoutMs: timeout, maxBytes: WORKER_OUTPUT_BYTES }, request }
}
