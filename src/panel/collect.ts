/**
 * Opt-in capture of new conversations into the session's own working directory
 * (issue #205 §五), and the NDJSON → JSON fold that keeps it crash safe.
 *
 * One projected record per `session/event` is appended to
 * `<cwd>/.dsh-ops/panel/<sessionId>.ndjson` while a session is live, and folded
 * into the single JSON document `<sessionId>.json` at every turn end, on session
 * disposal. Disabling the component stops queued work and retains the append log. The JSON is the only data source; `panel.html` is a
 * viewer that reads it. Three contracts shape the code:
 *
 * - **Capture can never break a session.** Every entry point is wrapped, every
 *   async write is chained and caught, and a failure is reported once per kind;
 *   the handler must not throw into a committed append.
 * - **Data stays bounded.** `textLimit` clamps one text field, `maxSessionBytes`
 *   caps the append log (further records are dropped and counted), and the fold
 *   trims the oldest view rows when the JSON would overrun the same cap.
 * - **Nothing outside the session workspace is touched.** Paths come from the
 *   session's own `header.cwd`; a cwd inside the DSH home, a relative cwd and an
 *   id that cannot be a file name are refused with one log line each.
 *
 * The fold reuses `bench/run.schema.json` field names where the two documents
 * describe the same fact; one live session has no `arms`/`results` counterpart.
 *
 * @module dsh-ops/panel/collect
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dshHome } from '../paths.js'
import { renderPanelHtml } from './render.js'
import { activityGate } from './activity.js'
import { object, field, finite, foldEvent, missingFile } from './types.js'
import type { Row, PanelConfig, PanelPaths, TextField, CoreBucket, UsageBucket, Usage, CaptureEvent, ArchiveMember, FoldedEvents, SessionState, FoldContext, CollectorOptions } from './types.js'

/** Document format tag; a reader must reject a tag it does not know. */
export const PANEL_FORMAT = 'dsh-ops/panel-capture@1'
/** Directory below the session working directory that holds both panel files. */
export const PANEL_DIR = path.join('.dsh-ops', 'panel')
/** The viewer file name inside {@link PANEL_DIR}. */
export const PANEL_HTML = 'panel.html'
/** Recognised row keys and their defaults; `capture` is the user-facing switch. */
export const PANEL_DEFAULTS: PanelConfig = Object.freeze({ capture: true, textLimit: 2_000, maxSessionBytes: 8 * 1024 * 1024 })

// View guards: a pathological session must not turn the trace into the document.
const TRACE_LIMIT = 20_000
const CONVERSATION_LIMIT = 20_000
/** Distinct tool names the histogram keeps before folding the rest into `(other)`. */
const TOOL_NAME_LIMIT = 64
/** Characters of a tool name line kept in a trace preview. */
const PREVIEW_CHARS = 120
/** The four core usage buckets in `bench/run.schema.json` order, and the optional ones. */
const USAGE_BUCKETS: readonly CoreBucket[] = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
const OPTIONAL_BUCKETS: readonly UsageBucket[] = Object.freeze(['reasoningTokens', 'totalTokens'])

/** Error raised for a panel configuration value this component cannot honour. */
export class PanelConfigError extends Error {
  /** @param {string} message - what is wrong and what is accepted. */
  constructor(message: string) {
    super(`dsh-ops panel config: ${message}`)
    this.name = 'PanelConfigError'
  }
}

/** Validate one row's config, applying every default; unknown or out-of-range values fail loud. */
export function resolvePanelConfig(options: unknown = {}): PanelConfig {
  if (!object(options) || Array.isArray(options)) {
    throw new PanelConfigError(`config must be an object, got ${JSON.stringify(options)}`)
  }
  const accepted = Object.keys(PANEL_DEFAULTS)
  const unknown = Object.keys(options).filter((key) => !accepted.includes(key))
  if (unknown.length > 0) {
    throw new PanelConfigError(`unknown key ${JSON.stringify(unknown[0])}; accepted keys are `
      + `${accepted.map((key) => JSON.stringify(key)).join(', ')}`)
  }
  const config = { ...PANEL_DEFAULTS, ...options }
  if (typeof config.capture !== 'boolean') {
    throw new PanelConfigError(`capture must be a boolean, got ${JSON.stringify(config.capture)}`)
  }
  if (typeof config.textLimit !== 'number' || !Number.isSafeInteger(config.textLimit) || config.textLimit < 64 || config.textLimit > 100_000) {
    throw new PanelConfigError(`textLimit must be an integer from 64 to 100000, got ${JSON.stringify(config.textLimit)}`)
  }
  if (typeof config.maxSessionBytes !== 'number' || !Number.isSafeInteger(config.maxSessionBytes)
    || config.maxSessionBytes < 64 * 1024 || config.maxSessionBytes > 256 * 1024 * 1024) {
    throw new PanelConfigError(`maxSessionBytes must be an integer from 65536 to 268435456, got ${JSON.stringify(config.maxSessionBytes)}`)
  }
  return Object.freeze({ capture: config.capture, textLimit: config.textLimit, maxSessionBytes: config.maxSessionBytes })
}

/**
 * A session id is used as a file name, so only a conservative character set is
 * accepted: an id this plugin cannot name safely is a session it does not capture.
 * @param {unknown} value - the candidate id.
 * @returns {string|undefined} the id, or undefined when it cannot be a file name.
 */
export function safeSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined
}

/** Whether `child` is `parent` or lies below it, on resolved paths. */
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve the three panel paths for one session, or refuse.
 * @returns {{dir: string, data: string, wal: string, html: string, sessionId: string}|undefined} the paths.
 */
export function panelPaths(cwd: unknown, sessionId: unknown, options: { env?: NodeJS.ProcessEnv } = {}): PanelPaths | undefined {
  const id = safeSessionId(sessionId)
  if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd) || id === undefined) return undefined
  const root = path.resolve(cwd)
  // The capture directory belongs to the workspace, never to the harness home
  // (§五 "不写 ~/.dsh"), even when a session happens to run inside it.
  if (within(root, dshHome(options.env))) return undefined
  const dir = path.join(root, PANEL_DIR)
  return Object.freeze({
    dir, data: path.join(dir, `${id}.json`), wal: path.join(dir, `${id}.ndjson`),
    html: path.join(dir, PANEL_HTML), sessionId: id,
  })
}

/** Clamp one text field, naming what was dropped so a reader can tell truncation apart. */
function clamp(value: unknown, limit: number) {
  const full = typeof value === 'string' ? value : ''
  if (full.length <= limit) return { text: full, chars: full.length, truncated: false, droppedChars: 0 }
  return { text: full.slice(0, limit), chars: full.length, truncated: true, droppedChars: full.length - limit }
}

/** Non-negative safe integer, or undefined. */
const integer = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)
/** Non-empty string, or undefined. */
const string = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

/** Message content blocks of one type, in order; anything unrecognised is skipped. */
function blocks(message: unknown, type: string): Row[] {
  const content = field(message, 'content')
  if (!Array.isArray(content)) return []
  return content.filter((block: unknown): block is Row => object(block) && block.type === type)
}

/** Concatenate the text of one content-block type, and name the tool calls, in order. */
function joined(message: unknown, type: string): string {
  return blocks(message, type).filter((block) => typeof block.text === 'string').map((block) => block.text).join('\n')
}
function toolNames(message: unknown): string[] {
  return blocks(message, 'tool-call').flatMap(block => typeof block.name === 'string' ? [block.name] : [])
}

/** Project one usage report onto the core buckets plus the optional ones actually sent. */
function projectUsage(usage: unknown) {
  if (!object(usage)) return { reported: false, usage: {}, buckets: [] }
  const projected: Usage = {}
  const buckets: UsageBucket[] = []
  for (const key of [...USAGE_BUCKETS, ...OPTIONAL_BUCKETS]) {
    const value = usage[key]
    if (finite(value) && value >= 0) { projected[key] = Math.round(value); buckets.push(key) }
  }
  return { reported: USAGE_BUCKETS.every((key) => key in projected), usage: projected, buckets }
}

/**
 * Project one session event onto the bounded append-log record. An event this
 * module does not recognise is still recorded by type, so a newer harness shows
 * up in the document instead of vanishing.
 * @returns {object|undefined} the projected record, or undefined when it is unusable.
 */
export function projectEvent(event: unknown, config: PanelConfig = PANEL_DEFAULTS): CaptureEvent | undefined {
  if (!object(event)) return undefined
  const type = string(event.type)
  const seq = integer(event.seq)
  if (type === undefined || seq === undefined) return undefined
  const time = finite(event.time) && event.time >= 0 ? event.time : 0
  const base = { seq, time, type }
  const data = event.data
  if (!object(data)) return base
  switch (type) {
    case 'user/message':
      return { ...base, role: 'user', source: string(field(data.source, 'kind')), payload: clamp(joined(data, 'text'), config.textLimit) }
    case 'assistant/message': {
      const usage = projectUsage(data.usage)
      return { ...base, role: 'assistant', turn: integer(data.turn), step: integer(data.step),
        interrupted: data.interrupted === true, toolCalls: toolNames(data.message),
        payload: clamp(joined(data.message, 'text'), config.textLimit),
        reasoning: clamp(joined(data.message, 'reasoning'), config.textLimit),
        usage: usage.usage, usageReported: usage.reported, usageBuckets: usage.buckets }
    }
    case 'tool/call':
      return {
        ...base, callId: string(data.callId), name: string(data.name) ?? '(unnamed)', step: integer(data.step),
        arguments: clamp(typeof data.arguments === 'string' ? data.arguments : '', config.textLimit),
      }
    case 'tool/result':
      return {
        ...base, callId: string(field(field(data.message, 'source'), 'callId')) ?? string(field(data.message, 'toolCallId')),
        isError: field(data.message, 'isError') === true, errorCode: string(field(data.error, 'code')), step: integer(data.step),
        payload: clamp(joined(data.message, 'text'), config.textLimit),
      }
    case 'turn/start': case 'turn/end': case 'step/start': case 'step/end':
      return {
        ...base, turn: integer(data.turn), step: integer(data.step),
        reason: string(field(data.reason, 'kind')) ?? string(field(data.reason, 'message')),
      }
    default:
      return base
  }
}
/** Byte length, so the append-log budget stays honest on multi-byte text. */
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * Read one NDJSON append log, counting lines that are not objects instead of
 * failing the whole fold on one bad byte sequence.
 * @param {string} text - the file contents.
 * @returns {{records: object[], malformed: number}} the parsed records.
 */
export function parseAppendLog(text: string): { records: Row[]; malformed: number } {
  const records: Row[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (object(parsed) && !Array.isArray(parsed)) records.push(parsed)
      else malformed += 1
    } catch { malformed += 1 }
  }
  return { records, malformed }
}

/** A fresh four-bucket usage total. */
const emptyUsage = (): Record<CoreBucket, number> & { grandTotal: number; reasoningTokens?: number } => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: 0 })
/** One conversation row: the fields every captured message shares. */
function messageRow(record: CaptureEvent, role: string) {
  const payload = record.payload ?? {}
  return {
    seq: record.seq, time: record.time, at: new Date(record.time).toISOString(), role,
    turn: record.turn, step: record.step, callId: record.callId,
    text: payload.text ?? '', chars: payload.chars ?? 0,
    truncated: payload.truncated === true, droppedChars: payload.droppedChars ?? 0,
  }
}

/** One trace row, in the lane vocabulary the panel draws. */
function traceRow(record: CaptureEvent, lane: string, kind: string, extra: Row = {}) {
  return { seq: record.seq, time: record.time, at: new Date(record.time).toISOString(), lane, kind, ...extra }
}

/**
 * Fold one session's records into the document `panel.html` reads.
 * @param {object[]} records - parsed append-log records, in order.
 * @param {{config?: object, meta?: object, droppedEvents?: number, malformed?: number}} [context] - fold inputs.
 * @returns {object} the panel document.
 */
export function foldRecords(records: readonly unknown[], context: FoldContext = {}) {
  const config = context.config ?? PANEL_DEFAULTS
  const supplied = { ...(context.meta ?? {}) }
  const conversation: Row[] = []
  const trace: Row[] = []
  const pending = new Map<string, { name: string; startedAt: number }>()
  const usage = emptyUsage()
  const bucketNames = new Set<string>()
  const eventTypes: Record<string, number> = {}
  const toolCallsByName: Record<string, number> = {}
  const counters = {
    turns: 0, steps: 0, stepsWithUsage: 0, toolCalls: 0, toolErrors: 0,
    textChars: 0, thinkingChars: 0, eventCount: 0, usageReported: true,
  }
  let sessionId: string | undefined
  let cwd: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  let turnEndReason: string | undefined
  let capped = false
  let conversationTruncated = false
  let traceTruncated = false
  let droppedChars = 0
  let malformedRecords = 0

  const mark = (ms: number) => {
    if (!Number.isFinite(ms) || ms <= 0) return
    if (startedAt === undefined || ms < startedAt) startedAt = ms
    if (endedAt === undefined || ms > endedAt) endedAt = ms
  }
  const pushConversation = (row: Row) => {
    if (conversation.length >= CONVERSATION_LIMIT) conversationTruncated = true
    else conversation.push(row)
  }
  const pushTrace = (row: Row) => {
    if (trace.length >= TRACE_LIMIT) traceTruncated = true
    else trace.push(row)
  }
  const preview = (value: unknown) => String(value ?? '').replace(/\s+/gu, ' ').slice(0, PREVIEW_CHARS)
  const dropped = (field: TextField | null | undefined) => { if (field?.truncated === true) droppedChars += field.droppedChars ?? 0 }

  for (const record of records) {
    if (!object(record) || Array.isArray(record)) continue
    if (record.record === 'open') {
      sessionId = string(record.sessionId) ?? sessionId
      cwd = string(record.cwd) ?? cwd
      continue
    }
    if (record.record === 'capped') { capped = true; continue }
    if (record.record !== 'event') continue
    if (!foldEvent(record)) { malformedRecords += 1; counters.usageReported = false; continue }
    const time = Number.isFinite(record.time) && record.time >= 0 ? record.time : 0
    counters.eventCount += 1
    eventTypes[record.type] = (eventTypes[record.type] ?? 0) + 1
    mark(time)
    const payload = record.payload ?? {}
    dropped(payload)
    dropped(record.reasoning)
    dropped(record.arguments)
    switch (record.type) {
      case 'user/message':
        pushConversation({ ...messageRow(record, 'user'), source: record.source })
        pushTrace(traceRow(record, 'milestone', 'user_message', { text: preview(payload.text) }))
        break
      case 'assistant/message': {
        const calls = Array.isArray(record.toolCalls) ? record.toolCalls.filter((name) => typeof name === 'string') : []
        counters.textChars += payload.chars ?? 0
        counters.thinkingChars += record.reasoning?.chars ?? 0
        if (record.usageReported === true) {
          counters.stepsWithUsage += 1
          for (const bucket of Array.isArray(record.usageBuckets) ? record.usageBuckets : []) bucketNames.add(bucket)
          for (const key of USAGE_BUCKETS) usage[key] += record.usage?.[key] ?? 0
          if (finite(record.usage?.reasoningTokens)) usage.reasoningTokens = (usage.reasoningTokens ?? 0) + record.usage.reasoningTokens
        } else counters.usageReported = false
        pushConversation({ ...messageRow(record, 'assistant'), reasoning: record.reasoning?.text ?? '', toolCalls: calls, interrupted: record.interrupted === true })
        pushTrace(traceRow(record, 'milestone', record.interrupted === true ? 'assistant_interrupted' : 'assistant_message', {
          text: calls.length > 0 ? `assistant → ${calls.join(', ')}` : preview(payload.text),
        }))
        break
      }
      case 'tool/call': {
        counters.toolCalls += 1
        const name = record.name ?? '(unnamed)'
        const key = Object.hasOwn(toolCallsByName, name) || Object.keys(toolCallsByName).length < TOOL_NAME_LIMIT ? name : '(other)'
        toolCallsByName[key] = (toolCallsByName[key] ?? 0) + 1
        if (record.callId !== undefined) pending.set(record.callId, { name, startedAt: time })
        pushTrace(traceRow(record, 'tool_call', 'tool_call', {
          name, callId: record.callId, step: record.step, text: preview(record.arguments?.text),
        }))
        break
      }
      case 'tool/result': {
        const call = record.callId === undefined ? undefined : pending.get(record.callId)
        if (record.callId !== undefined) pending.delete(record.callId)
        const failed = record.isError === true
        if (failed) counters.toolErrors += 1
        pushConversation({ ...messageRow(record, 'tool'), isError: failed })
        pushTrace(traceRow(record, 'tool_result', failed ? 'tool_error' : 'tool_result', {
          name: call?.name, callId: record.callId, isError: failed, errorCode: record.errorCode, step: record.step,
          durationMs: call === undefined ? undefined : Math.max(0, time - call.startedAt),
          text: failed ? `${call?.name ?? 'tool'} failed${record.errorCode ? ` (${record.errorCode})` : ''}` : preview(payload.text),
        }))
        break
      }
      case 'step/start': case 'step/end':
        if (record.type === 'step/start') counters.steps += 1
        pushTrace(traceRow(record, 'milestone', record.type === 'step/start' ? 'step_start' : 'step_end', {
          step: record.step, text: record.type === 'step/start' ? 'request sent' : 'step finished',
        }))
        break
      case 'turn/start':
        counters.turns += 1
        pushTrace(traceRow(record, 'milestone', 'turn_start', { text: 'turn started' }))
        break
      case 'turn/end':
        turnEndReason = record.reason ?? turnEndReason
        pushTrace(traceRow(record, 'milestone', 'turn_end', {
          reason: record.reason, text: `turn ended${record.reason ? ` (${record.reason})` : ''}`,
        }))
        break
      case 'assistant/attempt':
        pushTrace(traceRow(record, 'error', 'assistant_attempt', { text: 'model attempt committed no message' }))
        break
      default:
        break
    }
  }
  usage.grandTotal = USAGE_BUCKETS.reduce((total, key) => total + usage[key], 0)
  const at = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
  const events: FoldedEvents = { layout: 'merged', merged: true, mergedAt: undefined,
    records: counters.eventCount, malformed: (context.malformed ?? 0) + malformedRecords, types: eventTypes, files: [] }
  const archive: ArchiveMember[] = []
  return {
    schemaVersion: 1,
    format: PANEL_FORMAT,
    meta: {
      pluginVersion: string(supplied.pluginVersion), platform: string(supplied.platform) ?? process.platform,
      node: string(supplied.node) ?? process.version,
      argv: Array.isArray(supplied.argv) ? supplied.argv.map((value) => String(value)) : [],
      sessionId, cwd, startedAt: at(startedAt), endedAt: at(endedAt),
    },
    metrics: {
      format: PANEL_FORMAT, sessionId, startedAt: at(startedAt), endedAt: at(endedAt),
      durationMs: startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt),
      ...counters, toolCallsByName, usage, usageBucketsSeen: [...bucketNames].sort(),
      turnEndReason, malformed: (context.malformed ?? 0) + malformedRecords,
    },
    conversation,
    trace,
    verify: {
      checks: 0, passed: 0, failed: 0,
      degraded: capped || conversationTruncated || traceTruncated || malformedRecords > 0,
      notes: [
        '实时采集没有 verifier:「判卷」标签页只反映采集自身的完整性,不代表任何任务的通过情况。',
        '只有挂载之后产生的事件会被采集;挂载之前的历史与已恢复的会话前缀不回放。',
      ],
    },
    events,
    archive,
    limits: {
      textLimit: config.textLimit ?? PANEL_DEFAULTS.textLimit, maxSessionBytes: config.maxSessionBytes ?? PANEL_DEFAULTS.maxSessionBytes,
      truncated: capped, droppedEvents: context.droppedEvents ?? 0, droppedChars,
      traceTruncated, conversationTruncated, trimmed: false, trimmedRows: 0,
    },
  }
}

/**
 * Shrink a document until it fits `cap`, dropping the oldest view rows first.
 * Metrics and usage totals are never dropped: they stay the complete accounting.
 * @returns {{text: string, bytes: number, trimmedRows: number}} the fitted text.
 */
export function fitDocument(document: ReturnType<typeof foldRecords>, cap: number) {
  let text = JSON.stringify(document)
  let size = bytes(text)
  let trimmedRows = 0
  while (size > cap && (document.conversation.length > 0 || document.trace.length > 0)) {
    const batch = Math.max(1, Math.ceil((size - cap) / 256))
    if (document.trace.length >= document.conversation.length) trimmedRows += document.trace.splice(0, batch).length
    else trimmedRows += document.conversation.splice(0, batch).length
    text = JSON.stringify(document)
    size = bytes(text)
  }
  document.limits.trimmed = trimmedRows > 0
  document.limits.trimmedRows = trimmedRows
  if (trimmedRows > 0) { text = JSON.stringify(document); size = bytes(text) }
  return { text, bytes: size, trimmedRows }
}

/**
 * Create the capture sink for one activation. It owns no timers and registers
 * nothing; persistence is per session and lazy, so no directory exists until the
 * first event of the first captured session arrives.
 * @param {object} [options] - `config`, `io`, `env`, `now`, `report` and `meta` seams.
 * Returns the collector for this activation.
 */
export function createPanelCollector(options: CollectorOptions = {}) {
  const config = options.config ?? PANEL_DEFAULTS
  const storage = options.io ?? fsp
  const activity = activityGate()
  // Fence each filesystem operation, including continuations after an awaited
  // read/write. Queued folds cannot start fresh writes once the row is stopped.
  const io = {
    readText: (file: string) => activity.run(() => storage.readFile(file, 'utf8')),
    readFile: (file: string) => activity.run(() => storage.readFile(file)),
    mkdir: (dir: string, options: { recursive: true }) => activity.run(() => storage.mkdir(dir, options)),
    appendFile: (file: string, data: string) => activity.run(() => storage.appendFile(file, data)),
    writeFile: (file: string, data: string) => activity.run(() => storage.writeFile(file, data)),
    rename: (from: string, to: string) => activity.run(() => storage.rename(from, to)),
    stat: (file: string) => activity.run(() => storage.stat(file)),
    rm: (file: string, options: { force: true }) => activity.run(() => storage.rm(file, options)),
  }
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  const report = typeof options.report === 'function' ? options.report : () => {}
  const meta = options.meta ?? {}
  const sessions = new Map<string, SessionState>()
  const noted = new Set<string>()
  let disposed = false
  let stopping: Promise<void> | undefined

  // Say something at most once per kind; reporting must never escape either.
  function note(key: string, message: string, level = 'warn') {
    if (noted.has(key)) return
    noted.add(key)
    try { report(message, level) } catch { /* a logger failure is not the session's problem */ }
  }
  function fail(key: string, error: unknown) {
    if (activity.cancelled(error)) return
    const reason = error instanceof Error ? error.message : String(error)
    note(key, `dsh-ops panel: capture failed (${key}): ${reason}; this session continues uncaptured.`, 'warn')
  }

  /** Read the append log's first record and size, or undefined when it is unusable. */
  async function readAppendLog(wal: string) {
    let text
    try { text = await io.readText(wal) } catch (error) {
      if (missingFile(error)) return undefined
      throw error
    }
    if (text.trim() === '') return undefined
    let header: Row | undefined
    try {
      const parsed: unknown = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')))
      if (object(parsed) && parsed.record === 'open') header = parsed
    } catch { /* a corrupted header is counted as malformed by the fold */ }
    return { header, size: bytes(text) }
  }

  /** Open (or resume) one session's append log; refuse with one log line, never a throw. */
  function open(sessionId: string, cwd: unknown): SessionState | undefined {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const paths = panelPaths(cwd, sessionId, { env })
    if (paths === undefined || typeof cwd !== 'string') {
      note(`path:${String(cwd)}`, `dsh-ops panel: not capturing session ${JSON.stringify(sessionId)}: `
        + 'the session needs an absolute working directory outside the DSH home and a file-name-safe id.', 'warn')
      return undefined
    }
    const state: SessionState = {
      sessionId, paths, size: 0, droppedEvents: 0, capped: false, closed: false,
      header: undefined, chain: Promise.resolve(),
    }
    sessions.set(sessionId, state)
    state.chain = (async () => {
      const prior = await readAppendLog(paths.wal)
      if (prior !== undefined) {
        state.size = prior.size
        state.header = prior.header
        return
      }
      const header = { record: 'open', sessionId, cwd: path.resolve(cwd), at: new Date(now()).toISOString(), pluginVersion: string(meta.pluginVersion) }
      const line = `${JSON.stringify(header)}\n`
      await io.mkdir(paths.dir, { recursive: true })
      await io.appendFile(paths.wal, line)
      state.size += bytes(line)
      state.header = header
    })().catch((error) => { fail('open', error) })
    return state
  }

  /** Append one record, or count it as dropped once the session budget is spent. */
  function append(state: SessionState, record: CaptureEvent & { record: string }) {
    if (state.closed) return
    let line
    try { line = `${JSON.stringify(record)}\n` } catch (error) { fail('serialize', error); return }
    const size = bytes(line)
    if (state.capped || state.size + size > config.maxSessionBytes) {
      state.droppedEvents += 1
      if (!state.capped) {
        state.capped = true
        const capLine = `${JSON.stringify({ record: 'capped', at: new Date(now()).toISOString(), limitBytes: config.maxSessionBytes })}\n`
        state.size += bytes(capLine)
        state.chain = state.chain
          .then(() => io.appendFile(state.paths.wal, capLine))
          .catch((error) => { fail('append-cap', error) })
      }
      return
    }
    state.size += size
    state.chain = state.chain
      .then(() => io.appendFile(state.paths.wal, line))
      .catch((error) => { fail('append', error) })
  }

  /** Write `panel.html` when it is absent or stale, and describe it for the archive. */
  async function writeViewer(state: SessionState) {
    const html = renderPanelHtml()
    let current
    try { current = await io.readText(state.paths.html) } catch (error) {
      if (!missingFile(error)) throw error
    }
    if (current !== html) {
      await io.mkdir(state.paths.dir, { recursive: true })
      await io.writeFile(`${state.paths.html}.tmp-${process.pid}`, html)
      await io.rename(`${state.paths.html}.tmp-${process.pid}`, state.paths.html)
    }
    return describe(state.paths.html, PANEL_HTML, 'panel')
  }

  /** Stat and hash one archive member, or undefined when it is not on disk. */
  async function describe(file: string, relative: string, role: string): Promise<ArchiveMember | undefined> {
    try {
      const [info, contents] = await Promise.all([io.stat(file), io.readFile(file)])
      return { path: relative, bytes: info.size, sha256: createHash('sha256').update(contents).digest('hex'), role }
    } catch (error) {
      if (missingFile(error)) return undefined
      throw error
    }
  }

  /** Fold the append log into the JSON document and refresh the viewer. */
  async function materialise(state: SessionState, final: boolean): Promise<void> {
    const { paths } = state
    let text = ''
    try { text = await io.readText(paths.wal) } catch (error) {
      if (!missingFile(error)) throw error
    }
    const parsed = parseAppendLog(text)
    const document = foldRecords(parsed.records, { config, meta, droppedEvents: state.droppedEvents, malformed: parsed.malformed })
    document.events.mergedAt = new Date(now()).toISOString()
    let viewer
    try { viewer = await writeViewer(state) } catch (error) { fail('viewer', error) }
    const archive: ArchiveMember[] = []
    if (!final) {
      const log = await describe(paths.wal, `${state.sessionId}.ndjson`, 'events')
      if (log !== undefined) {
        archive.push(log)
        // `bench/run.schema.json` ties `events.files` to the NDJSON a document was sealed from.
        document.events.files = [{ path: log.path, events: document.events.records, sha256: log.sha256 }]
      }
    }
    if (viewer !== undefined) archive.push(viewer)
    document.archive = archive
    await io.mkdir(paths.dir, { recursive: true })
    await io.writeFile(`${paths.data}.tmp-${process.pid}`, fitDocument(document, config.maxSessionBytes).text)
    await io.rename(`${paths.data}.tmp-${process.pid}`, paths.data)
    if (final) { try { await io.rm(paths.wal, { force: true }) } catch (error) { fail('seal', error) } }
  }

  /** Queue a fold behind every append already scheduled for this session. */
  function merge(sessionId: string, final = false): Promise<void> {
    const state = sessions.get(sessionId)
    if (state === undefined) return Promise.resolve(undefined)
    state.chain = state.chain
      .then(() => materialise(state, final))
      .catch((error) => { fail('merge', error) })
    return state.chain
  }

  const collector = {
    config,
    /** Observe one committed session event; never throws, never rejects. */
    observe(session: unknown, event: unknown): void {
      if (disposed) return
      try {
        const sessionId = safeSessionId(field(session, 'id'))
        if (sessionId === undefined) return
        const state = open(sessionId, field(field(session, 'header'), 'cwd') ?? field(session, 'cwd'))
        if (state === undefined) return
        const projected = projectEvent(event, config)
        if (projected === undefined) return
        append(state, { record: 'event', ...projected })
        // A turn end is the idle point: fold then, so the JSON is current without
        // a timer and without waiting for the session to be disposed.
        if (projected.type === 'turn/end') void merge(sessionId)
      } catch (error) { fail('observe', error) }
    },
    /** Wait for every append scheduled for one session (or all of them). */
    flush(sessionId?: string): Promise<void> {
      const targets = sessionId === undefined ? [...sessions.values()] : [sessions.get(sessionId)].filter((state): state is SessionState => state !== undefined)
      return Promise.all(targets.map((state) => state.chain)).then(() => undefined)
    },
    /** Fold one session's append log into its JSON document. */
    merge(sessionId: string): Promise<void> { return merge(sessionId, false) },
    /** Seal one session: final fold that drops the append log. */
    close(sessionId: string): Promise<void> {
      const state = sessions.get(sessionId)
      if (state === undefined || state.closed) return Promise.resolve(undefined)
      state.closed = true
      return merge(sessionId, true).then(() => { sessions.delete(sessionId) })
    },
    /** Stop collection without starting a final fold. Await all issued I/O before
     * the loader reports this row disabled; retained append logs remain recoverable. */
    stop(): Promise<void> {
      if (stopping) return stopping
      disposed = true
      activity.stop()
      stopping = collector.flush().then(() => { sessions.clear() })
      return stopping
    },
    /** Explicitly seal every session. Component teardown uses stop() instead. */
    dispose(): Promise<void> {
      if (disposed) return Promise.resolve(undefined)
      disposed = true
      return Promise.all([...sessions.keys()].map((sessionId) => collector.close(sessionId))).then(() => undefined)
    },
    /** The paths one captured session writes to, for callers that must report them. */
    pathsFor(sessionId: string): PanelPaths | undefined { return sessions.get(sessionId)?.paths },
    /** How many sessions this activation has captured. */
    get size() { return sessions.size },
  }
  return Object.freeze(collector)
}
