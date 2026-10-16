/** Session-owned background process tools over the DSH subprocess contract. */
import { Buffer } from 'node:buffer'
import { publicToolName } from './policy.js'
import { MODES, denied } from './permissions.js'
import { prepareWorkspace } from './workspace-preparation.js'
import { confinedBash } from './bash-ipc.js'
import { sessionWorkdir } from './session-shells.js'
import { DEFAULT_BASH_TIMEOUT_MS, DEFAULT_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_SPILL_BYTES, MAX_BASH_TIMEOUT_MS, shellEnvOverrides } from './shells.js'

export const PROCESS_TOOLS = Object.freeze(['process_start', 'process_output', 'process_list', 'process_kill'])
const PROCESS_NAMES = Object.freeze(PROCESS_TOOLS.map(publicToolName))
const MAX_READ_BYTES = 64_000
let nextId = 1

function result(status, fields = {}) { return { status, ...fields } }
function policyFor(ctx, session) {
  return ctx.get('sandboxPolicy')?.resolve({ session })
}
function allowed(ctx, session) {
  try {
    const policy = policyFor(ctx, session)
    return MODES.includes(policy?.mode) && (policy.mode === 'danger-full-access' || typeof ctx.get('sandbox')?.confine === 'function')
  } catch { return false }
}
function owner(entry, session) {
  return entry?.session === session && entry?.connection === entry.connection
}
function processId() { return `p-${Date.now().toString(36)}-${(nextId++).toString(36)}` }
function outputReader(handle, stream) { return handle.collected?.[stream] }
function boundedRead(reader, offset, limit) {
  if (!reader || typeof reader.readFrom !== 'function') return { text: '', nextOffset: offset, truncated: false, bytes: 0, bytesTotal: offset, lines: 0 }
  const read = reader.readFrom(offset)
  const source = typeof read.text === 'string' ? read.text : ''
  const bytes = Buffer.from(source)
  const clipped = bytes.length > limit
  const text = clipped ? bytes.subarray(0, limit).toString() : source
  const consumed = Buffer.byteLength(text)
  return {
    text,
    nextOffset: clipped ? offset + consumed : read.nextOffset,
    truncated: read.lossy === true || clipped,
    bytes: consumed,
    bytesTotal: Number.isFinite(read.nextOffset) ? read.nextOffset : offset + bytes.length,
    lines: text === '' ? 0 : text.split(/\n/).length,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  }
}

function definitions(state) {
  const start = {
    name: publicToolName('process_start'),
    description: 'Start a session-owned background bash process through DSH subprocess and sandbox policy. Returns an id; use process_output, process_list, and process_kill only for processes started in this session.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      command: { type: 'string' }, script_path: { type: 'string' }, workdir: { type: 'string' },
      timeoutMs: { type: 'number' }, graceMs: { type: 'number' }, includeDiagnostics: { type: 'boolean' },
    } },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: (args, exec) => state.start(args, exec),
  }
  const output = {
    name: publicToolName('process_output'),
    description: 'Read bounded stdout or stderr from a process started in this session. Use nextOffset for paging; spillPath is available when the retained output is lossy.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      process_id: { type: 'string' }, stream: { type: 'string', enum: ['stdout', 'stderr'] }, offset: { type: 'number' }, maxBytes: { type: 'number' },
    }, required: ['process_id'] },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: (args, exec) => state.output(args, exec?.agent?.session),
  }
  const list = {
    name: publicToolName('process_list'), description: 'List processes owned by this session, with bounded status and timing metadata.',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: (_args, exec) => state.list(exec?.agent?.session),
  }
  const kill = {
    name: publicToolName('process_kill'), description: 'Terminate a process started by this session and its provider-managed process range.',
    parameters: { type: 'object', additionalProperties: false, properties: { process_id: { type: 'string' } }, required: ['process_id'] },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: (args, exec) => state.kill(args, exec?.agent?.session),
  }
  return [start, output, list, kill]
}

export function mountSessionProcesses(ctx, config, shells) {
  if (!config.publishBashTool || !shells?.bash?.available || typeof ctx.get('subprocess')?.spawn !== 'function') return
  const entries = new Map()
  let ready = false
  let stopped = false
  const state = {
    start: async (args = {}, exec) => {
      const session = exec?.agent?.session
      if (!session || stopped || !ready || !allowed(ctx, session)) return result('failed', { error: 'EXECUTOR_UNAVAILABLE: DSH subprocess or sandbox authority is unavailable; no process was started.' })
      const policy = policyFor(ctx, session)
      const command = typeof args.command === 'string' && args.command.trim() ? args.command : undefined
      const script = typeof args.script_path === 'string' && args.script_path.trim() ? args.script_path : undefined
      if ((command ? 1 : 0) + (script ? 1 : 0) !== 1) throw new Error('invalid process input: provide exactly one of command or script_path')
      const timeoutMs = args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS
      const graceMs = args.graceMs ?? DEFAULT_GRACE_MS
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BASH_TIMEOUT_MS) throw new Error(`invalid timeoutMs: must be between 0 and ${MAX_BASH_TIMEOUT_MS}`)
      if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error('invalid graceMs: expected a positive number')
      const workdir = sessionWorkdir(args, session)
      const controller = new AbortController()
      const startedAt = Date.now()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('process timeout')) }, timeoutMs)
      timer.unref?.()
      const callerSignal = exec?.signal
      const abort = () => controller.abort(callerSignal?.reason)
      if (callerSignal?.aborted) abort(); else callerSignal?.addEventListener('abort', abort, { once: true })
      let entry
      try {
        const argv = command ? [shells.bash.file, '-c', command] : [shells.bash.file, script]
        await prepareWorkspace(policy)
        let confinement
        const runtime = policy.mode === 'danger-full-access' ? { file: shells.bash.file } : confinedBash(shells.bash.file, { source: shells.bash.source })
        if (policy.mode !== 'danger-full-access') {
          confinement = await ctx.get('sandbox').confine(argv, policy, controller.signal)
          if (!['full', 'partial'].includes(confinement?.enforcement) || !confinement.argv?.length) throw new Error('SANDBOX_UNAVAILABLE: invalid DSH confinement result; no process was started.')
        }
        const current = policyFor(ctx, session)
        if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) throw new Error('DSH permissions changed before execution; no process was started.')
        const handle = ctx.get('subprocess').spawn({ argv: confinement?.argv ?? [runtime.file, ...(command ? ['-c', command] : [script])], cwd: workdir, graceMs, signal: controller.signal,
          stdio: { stdin: 'ignore', stdout: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } }, stderr: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } } },
          env: shellEnvOverrides(process.env),
        })
        entry = { id: processId(), session, connection: state, handle, startedAt, timeoutMs, timedOut: () => timedOut, policy, confinement, timer, abort }
        entries.set(entry.id, entry)
        void handle.done.then(outcome => { entry.outcome = outcome }).catch(error => { entry.error = String(error?.message ?? error) }).finally(() => {
          entry.finishedAt = Date.now()
          clearTimeout(timer)
          callerSignal?.removeEventListener('abort', abort)
        })
        return result('started', { processId: entry.id, startedAt, timeoutMs, ...(args.includeDiagnostics === true ? { diagnostics: { executor: 'subprocess', source: shells.bash.source } } : {}) })
      } catch (error) {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', abort)
        return result('failed', { error: String(error?.message ?? error), timedOut })
      }
    },
    output: (args, session) => {
      const entry = entries.get(args?.process_id)
      if (entry && entry.session !== session) return result('failed', { error: 'PROCESS_NOT_OWNED: process is not owned by this session or is no longer available.' })
      if (!entry) return result('failed', { error: 'PROCESS_NOT_OWNED: process is not owned by this session or is no longer available.' })
      const stream = args?.stream ?? 'stdout'
      if (!['stdout', 'stderr'].includes(stream)) throw new Error('invalid stream: expected stdout or stderr')
      const offset = args?.offset ?? 0
      const limit = args?.maxBytes ?? MAX_READ_BYTES
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_READ_BYTES) throw new Error(`invalid output paging; maxBytes must be 1..${MAX_READ_BYTES}`)
      return result('ok', { processId: entry.id, stream, ...boundedRead(outputReader(entry.handle, stream), offset, limit), ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}) })
    },
    list: (session) => result('ok', { processes: [...entries.values()].filter(entry => entry.session === session).map(entry => ({ processId: entry.id, status: entry.finishedAt ? 'finished' : 'running', startedAt: entry.startedAt, ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}), ...(entry.outcome?.exitCode != null ? { exitCode: entry.outcome.exitCode } : {}), ...(entry.outcome?.signal ? { signal: entry.outcome.signal } : {}), timedOut: entry.timedOut() })) }),
    kill: (args, session) => {
      const entry = entries.get(args?.process_id)
      if (entry && entry.session !== session) return result('failed', { error: 'PROCESS_NOT_OWNED: process is not owned by this session or is no longer available.' })
      if (!entry) return result('failed', { error: 'PROCESS_NOT_OWNED: process is not owned by this session or is no longer available.' })
      entry.handle.terminate()
      return result('ok', { processId: entry.id, status: 'terminating' })
    },
  }
  const publish = agent => {
    if (!agent?.ctx || entries.has(agent)) return
    const record = { agent, ctx: undefined, fiber: undefined, disposers: [] }
    entries.set(agent, record)
    record.fiber = agent.ctx.plugin(child => child.inject(['tools'], toolsCtx => {
      record.ctx = toolsCtx
      reconcile()
    }))
  }
  const clear = record => { for (const dispose of record.disposers ?? []) { try { dispose?.() } catch {} } record.disposers = [] }
  const reconcile = () => {
    for (const record of [...entries.values()].filter(entry => entry.agent)) clear(record)
    for (const record of [...entries.values()].filter(entry => entry.agent)) {
      if (!record.ctx || !allowed(ctx, record.agent.session) || stopped) continue
      try { record.disposers = definitions(state).map(definition => record.ctx.tools.register(definition)) } catch { clear(record) }
    }
  }
  ctx.on('agent/created', ({ agent }) => publish(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const record = [...entries.values()].find(entry => entry.agent === agent)
    if (record) {
      clear(record)
      record.fiber?.dispose()
      entries.delete(record)
    }
    for (const entry of entries.values()) {
      if (!entry.agent && entry.session === agent?.session) {
        try { entry.handle.terminate() } catch {}
        entries.delete(entry.id)
      }
    }
    reconcile()
  })
  ctx.on('session/event', (_session, event) => { if (event.type === 'sandbox/mode') reconcile() })
  ctx.inject(['sandboxPolicy', 'subprocess'], () => { ready = true; reconcile() })
  ctx.effect(() => async () => { stopped = true; for (const record of [...entries.values()].filter(entry => entry.agent)) clear(record); for (const entry of entries.values()) if (!entry.agent) { try { entry.handle.terminate(); await entry.handle.waitForExit() } catch {} }; entries.clear() }, 'dsh-ops: session processes')
  for (const agent of ctx.get('agents')?.list?.() ?? []) publish(agent)
}

export { PROCESS_NAMES }
