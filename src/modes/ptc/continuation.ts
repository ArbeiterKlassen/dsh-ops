/** Continuations describe read-only retrieval. They are data, never authority or automatic retries. */
import type { CanonicalData, JsonValue } from './outcome.js'
const object = (value: unknown): CanonicalData | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as CanonicalData : undefined
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const readers = ['inspect_local_file', 'read_many', 'glob', 'grep', 'diff', 'result'] as const
export type ContinuationTool = typeof readers[number]
export interface RetrievalContinuation { version: 1, tool: ContinuationTool, args: CanonicalData }
const PREFIX = 'ops-next-v1:'
function encode(tool: ContinuationTool, args: CanonicalData): string | undefined {
  try {
    const token = PREFIX + JSON.stringify({ version: 1, tool, args } satisfies RetrievalContinuation)
    return Buffer.byteLength(token) <= 8192 ? token : undefined
  } catch { return undefined }
}
/** Decode only; callers choose whether and when to invoke an available SDK binding. */
export function decodeContinuation(token: string): RetrievalContinuation | undefined {
  if (typeof token !== 'string' || Buffer.byteLength(token) > 8192 || !token.startsWith(PREFIX)) return undefined
  try {
    const value = object(JSON.parse(token.slice(PREFIX.length)))
    const args = object(value?.args)
    if (!value || value.version !== 1 || !readers.includes(value.tool as ContinuationTool) || !args) return undefined
    if (value.tool === 'result' && args.action !== 'page') return undefined
    return { version: 1, tool: value.tool as ContinuationTool, args }
  } catch { return undefined }
}
function readMany(args: CanonicalData, data: CanonicalData): CanonicalData | undefined {
  if (!Array.isArray(args.files) || !Array.isArray(data.items) || !integer(data.nextIndex)) return undefined
  const files: JsonValue[] = []
  for (const [index, raw] of data.items.entries()) {
    const item = object(raw), request = object(args.files[index])
    if (!item || !request || item.error) return undefined
    if (item.complete === false) {
      if (!integer(item.nextOffset) || item.nextOffset <= Number(request.offset ?? 1)) return undefined
      files.push({ ...request, offset: item.nextOffset })
    }
  }
  files.push(...args.files.slice(data.nextIndex))
  return files.length ? { files } : undefined
}
export function continuationFor(tool: string, rawArgs: unknown, data: CanonicalData): string | undefined {
  const args = object(rawArgs) ?? {}
  const reference = object(data.reference)
  if (typeof reference?.refId === 'string' && reference.refId.startsWith('ref://')) {
    return encode('result', { action: 'page', id: reference.refId, offset: 0,
      ...(typeof data.referenceRoot === 'string' ? { root: data.referenceRoot } : {}) })
  }
  if (tool === 'result' && args.action === 'page' && integer(data.nextOffset) && data.nextOffset > Number(args.offset ?? 0)) {
    return encode('result', { ...args, offset: data.nextOffset })
  }
  if ((tool === 'grep' || tool === 'glob') && data.scanComplete === true && typeof data.continuation === 'string') {
    return encode(tool, { ...args, continuation: data.continuation, ...(integer(data.nextOffset) ? { offset: data.nextOffset } : {}) })
  }
  if (tool === 'read_many') {
    const next = readMany(args, data)
    return next ? encode('read_many', next) : undefined
  }
  if ((tool === 'inspect_local_file' || tool === 'diff') && integer(data.nextOffset)
    && data.nextOffset > Number(args.offset ?? (tool === 'inspect_local_file' ? 1 : 0))) {
    return encode(tool, { ...args, offset: data.nextOffset })
  }
  return undefined
}
