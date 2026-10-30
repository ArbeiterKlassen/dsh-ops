#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  credentialPath,
  credentialRefusal,
  credentialRoots,
} from '../vendor/credential-policy.js'
import {
  DESCRIPTIONS,
  PARAMETERS,
} from '../vendor/capabilities/file.js'
import {
  NATIVE_RESULT_DESCRIPTION,
  NATIVE_RESULT_PARAMETERS,
} from '../vendor/capabilities/result.js'
import {
  ADAPTER_VERSION,
  WORKER_VERSION,
  formatResolutionFailure,
  resolveWorkerBinary,
  scrubChildEnv,
  workspaceRoot,
} from './runtime.mjs'

const MUTATIONS = new Set([
  'replace',
  'write_file',
  'edit_file',
  'copy',
  'move',
  'remove',
])

const LARGE_JSON_BYTES = 64 * 1024
const MINIFIED_JSON_PROBE_BYTES = 8192
const MAX_MCP_OUTPUT_CHARS = 20_000

const TOOL_ORDER = [
  'inspect_local_file',
  'json_query',
  'grep',
  'glob',
  'replace',
  'write_file',
  'edit_file',
  'diff',
  'stat',
  'copy',
  'move',
  'remove',
  'read_files',
  'read_table',
  'read_docx',
  'read_pdf',
  'result',
]

const runtime = resolveWorkerBinary()
if (runtime.file === undefined) {
  process.stderr.write(`${formatResolutionFailure(runtime, 'dsh-ops worker')}\n`)
  process.stderr.write(
    'Run `node scripts/bootstrap-native.mjs` from the plugin, '
    + 'or set DSH_OPS_WORKER_BIN to a dsh-ops-worker executable.\n',
  )
  process.exit(2)
}

const serverScope = `codex-${process.pid}-${randomUUID()}`
const toolMap = new Map(TOOL_ORDER.map(name => {
  const inputSchema = name === 'result'
    ? NATIVE_RESULT_PARAMETERS
    : PARAMETERS[name]
  const description = name === 'result'
    ? NATIVE_RESULT_DESCRIPTION
    : DESCRIPTIONS[name]
  if (inputSchema === undefined || description === undefined) {
    throw new Error(`missing upstream schema for ${name}`)
  }
  return [name, {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: !MUTATIONS.has(name),
      destructiveHint: name === 'replace'
        || name === 'write_file'
        || name === 'edit_file'
        || name === 'copy'
        || name === 'move'
        || name === 'remove',
      idempotentHint: !MUTATIONS.has(name),
      openWorldHint: false,
    },
  }]
}))

process.stderr.write(
  `[dsh-ops-codex] worker ${WORKER_VERSION} from ${runtime.source}: ${runtime.file}\n`,
)

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  })
}

function requestRoot(args) {
  if (args && typeof args.root === 'string' && path.isAbsolute(args.root)) {
    return path.resolve(args.root)
  }
  return workspaceRoot()
}

function workerEnvelope(tool, args) {
  const root = requestRoot(args)
  const configuredWriteRoot = process.env.DSH_OPS_WRITE_ROOT
  const writeRoots = typeof configuredWriteRoot === 'string'
    && configuredWriteRoot.trim() !== ''
    && path.isAbsolute(configuredWriteRoot)
    ? [path.resolve(configuredWriteRoot)]
    : undefined

  return {
    version: 1,
    requestId: randomUUID(),
    component: 'file',
    budget: {
      timeoutMs: 29_000,
      maxBytes: 128 * 1024,
    },
    request: {
      root,
      scope: serverScope,
      tool,
      args: args ?? {},
      read_only: /^(1|true|yes|on)$/i.test(
        String(process.env.DSH_OPS_READ_ONLY ?? '').trim(),
      ),
      deny_roots: credentialRoots(),
      deny_credential_names: true,
      ...(writeRoots === undefined ? {} : { write_roots: writeRoots }),
    },
  }
}

function invokeWorker(tool, args) {
  const input = JSON.stringify(workerEnvelope(tool, args))
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) {
    return Promise.resolve({
      status: 'error',
      phase: 'preflight',
      changed: 0,
      failed: 1,
      complete: false,
      error: {
        code: 'OUTPUT_LIMIT',
        message: 'Request exceeds the 2 MiB worker budget.',
        effectState: 'none',
      },
    })
  }

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.file, [], {
      cwd: requestRoot(args),
      env: scrubChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('dsh-ops worker exceeded its 30 second deadline'))
    }, 30_000)

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error !== undefined) reject(error)
      else resolve(value)
    }

    child.once('error', error => finish(error))
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 128 * 1024) {
        child.kill()
        finish(new Error('dsh-ops worker output exceeded 128 KiB'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      if (stderrBytes >= 16 * 1024) return
      stderrBytes += chunk.length
      stderr.push(chunk)
    })
    child.once('close', code => {
      if (settled) return
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        finish(new Error(`dsh-ops worker exited ${code}${detail ? `: ${detail}` : ''}`))
        return
      }
      try {
        const value = JSON.parse(Buffer.concat(stdout).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('worker returned a non-object result')
        }
        finish(undefined, value)
      } catch (error) {
        finish(error)
      }
    })
    child.stdin.end(input)
  })
}

function parseSelector(selector) {
  const source = String(selector ?? '').trim()
  if (source === '') return []
  if (source.startsWith('/')) {
    return source.slice(1).split('/').filter(Boolean).map(part =>
      part.replace(/~1/g, '/').replace(/~0/g, '~')
    )
  }
  const tokens = []
  let index = 0
  while (index < source.length) {
    if (source[index] === '.') {
      index++
      continue
    }
    if (source[index] === '[') {
      const end = source.indexOf(']', index + 1)
      if (end < 0) throw new Error(`unclosed selector bracket at ${index}`)
      let inner = source.slice(index + 1, end).trim()
      if ((inner.startsWith('"') && inner.endsWith('"'))
        || (inner.startsWith("'") && inner.endsWith("'"))) {
        inner = inner.slice(1, -1)
      }
      tokens.push(/^\d+$/.test(inner) ? Number(inner) : inner)
      index = end + 1
      continue
    }
    const start = index
    while (index < source.length && source[index] !== '.' && source[index] !== '[') {
      index++
    }
    const token = source.slice(start, index).trim()
    if (token !== '') tokens.push(token)
  }
  return tokens
}

function selectorResult(root, selector) {
  let value = root
  const used = []
  for (const token of parseSelector(selector)) {
    if (value === null || value === undefined) {
      return { found: false, value: undefined, used }
    }
    if (typeof token === 'number') {
      if (!Array.isArray(value) || token < 0 || token >= value.length) {
        return { found: false, value: undefined, used }
      }
      value = value[token]
    } else {
      if (typeof value !== 'object' || !(token in value)) {
        return { found: false, value: undefined, used }
      }
      value = value[token]
    }
    used.push(token)
  }
  return { found: true, value, used }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function matchesWhere(value, where) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return true
  for (const [field, expected] of Object.entries(where)) {
    const selected = selectorResult(value, field)
    if (!selected.found || !deepEqual(selected.value, expected)) return false
  }
  return true
}

function projectFields(value, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return value
  if (value && typeof value === 'object'
    && Array.isArray(value.window) && 'matchIndex' in value) {
    return {
      ...value,
      window: value.window.map(item => projectFields(item, fields)),
    }
  }
  if (value === null || typeof value !== 'object') return value
  const projected = {}
  for (const field of fields) {
    if (typeof field !== 'string' || field.trim() === '') continue
    const selected = selectorResult(value, field)
    if (selected.found) projected[field] = selected.value
  }
  return projected
}

function summarizeJson(value) {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      firstIndexes: value.slice(0, 10).map((_, index) => index),
    }
  }
  if (value !== null && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, 100),
      keyCount: Object.keys(value).length,
    }
  }
  return { type: value === null ? 'null' : typeof value, value }
}

function boundedJsonPreview(value, cap) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= cap) return { text, truncated: false, chars: text.length }
  return {
    text: text.slice(0, Math.max(0, cap - 80))
      + '\n... [json_query preview truncated]',
    truncated: true,
    chars: text.length,
  }
}

function jsonReadRisk(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || path.extname(file).toLowerCase() !== '.json') return null
  if (stat.size > LARGE_JSON_BYTES) {
    return { bytes: stat.size, reason: 'the JSON file exceeds 64 KiB' }
  }
  if (stat.size <= 4096) return null
  const length = Math.min(stat.size, MINIFIED_JSON_PROBE_BYTES)
  const buffer = Buffer.alloc(length)
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const read = fs.readSync(fd, buffer, 0, length, 0)
    if (!buffer.subarray(0, read).includes(0x0a)) {
      return { bytes: stat.size, reason: 'the JSON file is minified onto one line' }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return null
}

function largeJsonReadRefusal(name, file, risk) {
  return {
    status: 'rejected',
    phase: 'preflight',
    changed: 0,
    failed: 1,
    complete: false,
    error: {
      code: 'JSON_QUERY_REQUIRED',
      effectState: 'none',
      message: `${name} refused ${file}: ${risk.reason} (${risk.bytes} bytes).`,
      nextAction:
        'Use json_query with selector/where/fields/context/limit/maxChars. '
        + 'Do not dump the whole JSON file into model context or a PowerShell/Python diagnostic command.',
    },
  }
}

function guardLargeJsonRead(name, args) {
  const root = requestRoot(args)
  const paths = name === 'read_files' && Array.isArray(args?.files)
    ? args.files
      .map(item => item && typeof item.path === 'string' ? item.path : undefined)
      .filter(Boolean)
    : name === 'inspect_local_file' && typeof args?.path === 'string'
      ? [args.path]
      : []
  for (const requested of paths) {
    const file = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(root, requested)
    const risk = jsonReadRisk(file)
    if (risk !== null) return largeJsonReadRefusal(name, file, risk)
  }
  return undefined
}

function jsonQuery(args) {
  const requested = typeof args?.path === 'string' ? args.path : ''
  if (requested.trim() === '') throw new Error('json_query requires path')
  const root = requestRoot(args)
  const file = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested)
  const denied = credentialPath(file, { env: process.env })
  if (denied.denied) {
    const refusal = credentialRefusal(file, denied.matched)
    return {
      status: 'rejected',
      phase: 'preflight',
      changed: 0,
      failed: 1,
      complete: false,
      error: refusal,
    }
  }
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('json_query path is not a regular file')
  if (stat.size > 256 * 1024 * 1024) {
    return {
      status: 'error',
      phase: 'preflight',
      changed: 0,
      failed: 1,
      complete: false,
      error: {
        code: 'JSON_TOO_LARGE',
        message: 'json_query refuses files larger than 256 MiB.',
      },
    }
  }
  const bytes = fs.readFileSync(file)
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '')
  let document
  try {
    document = JSON.parse(source)
  } catch (error) {
    return {
      status: 'error',
      phase: 'parse',
      changed: 0,
      failed: 1,
      complete: false,
      path: file,
      bytes: bytes.length,
      revision: createHash('sha256').update(bytes).digest('hex'),
      error: {
        code: 'INVALID_JSON',
        message: String(error?.message ?? error),
      },
    }
  }

  const selector = typeof args.selector === 'string' ? args.selector : ''
  const selected = selectorResult(document, selector)
  if (!selected.found) {
    return {
      status: 'error',
      phase: 'select',
      changed: 0,
      failed: 1,
      complete: false,
      path: file,
      bytes: bytes.length,
      selector,
      revision: createHash('sha256').update(bytes).digest('hex'),
      error: {
        code: 'SELECTOR_NOT_FOUND',
        message: `Selector not found: ${selector || '<root>'}`,
      },
    }
  }

  const limit = Math.max(1, Math.min(500, Number(args.limit) || 50))
  const offset = Math.max(0, Number(args.offset) || 0)
  const context = Math.max(0, Math.min(10, Number(args.context) || 0))
  const maxChars = Math.max(1000, Math.min(20000, Number(args.maxChars) || 12000))
  const fields = Array.isArray(args.fields) ? args.fields : []
  const where = args.where && typeof args.where === 'object' ? args.where : null
  const contains = typeof args.contains === 'string' && args.contains !== ''
    ? args.contains
    : null

  let candidates = []
  const rootSummaryOnly = selector === '' && !where && !contains
  if (!rootSummaryOnly && Array.isArray(selected.value)) {
    candidates = selected.value
      .map((value, index) => ({ value, index }))
      .filter(item => matchesWhere(item.value, where))
      .filter(item => !contains || JSON.stringify(item.value).includes(contains))
  } else if (!rootSummaryOnly) {
    if (matchesWhere(selected.value, where)
      && (!contains || JSON.stringify(selected.value).includes(contains))) {
      candidates = [{ value: selected.value, index: null }]
    }
  }

  const total = candidates.length
  const page = candidates.slice(offset, offset + limit)
  const perItemBudget = Math.max(256, Math.floor(maxChars / Math.max(1, page.length)))
  const items = []
  let usedChars = 0
  for (const item of page) {
    let value = item.value
    if (context > 0 && Array.isArray(selected.value) && item.index !== null) {
      const from = Math.max(0, item.index - context)
      const to = Math.min(selected.value.length, item.index + context + 1)
      value = {
        matchIndex: item.index,
        windowStart: from,
        window: selected.value.slice(from, to),
      }
    }
    const projected = projectFields(value, fields)
    const preview = boundedJsonPreview(projected, Math.max(256, perItemBudget - 120))
    if (usedChars + preview.text.length > maxChars && items.length > 0) break
    usedChars += preview.text.length
    items.push({
      index: item.index,
      preview: preview.text,
      truncated: preview.truncated,
      chars: preview.chars,
    })
  }

  const summary = selector === '' ? summarizeJson(selected.value) : null
  const truncated = offset + items.length < total
    || items.some(item => item.truncated)
  return {
    status: 'completed',
    phase: 'read',
    changed: 0,
    failed: 0,
    complete: !truncated,
    path: file,
    bytes: bytes.length,
    revision: createHash('sha256').update(bytes).digest('hex'),
    selector,
    matched: total,
    returned: items.length,
    offset,
    limit,
    context,
    nextOffset: offset + items.length < total ? offset + items.length : null,
    truncated,
    maxChars,
    summary,
    items,
  }
}

function boundedToolResponse(name, value) {
  const source = JSON.stringify(value, null, 2)
  if (typeof source !== 'string' || source.length <= MAX_MCP_OUTPUT_CHARS) {
    return { value, structuredValue: value, text: source }
  }
  const metadata = {
    status: value?.status ?? 'completed',
    phase: value?.phase ?? 'output',
    changed: value?.changed ?? 0,
    failed: value?.failed ?? 0,
    complete: false,
    truncated: true,
    truncatedBy: 'adapter-output-budget',
    tool: name,
    originalChars: source.length,
    outputBudget: MAX_MCP_OUTPUT_CHARS,
    nextAction:
      'Narrow the request with selector, offset/limit, fields, grep summary/count, '
      + 'or a smaller file range. Do not retry with a larger output request.',
  }
  const overhead = JSON.stringify({ ...metadata, preview: '' }, null, 2).length
  let previewChars = Math.max(1000, MAX_MCP_OUTPUT_CHARS - overhead - 64)
  let bounded = {
    ...metadata,
    preview: source.slice(0, previewChars),
  }
  let text = JSON.stringify(bounded, null, 2)
  while (text.length > MAX_MCP_OUTPUT_CHARS && previewChars > 1000) {
    previewChars = Math.max(
      1000,
      Math.floor(previewChars * (MAX_MCP_OUTPUT_CHARS / text.length)) - 128,
    )
    bounded = {
      ...metadata,
      preview: source.slice(0, previewChars),
    }
    text = JSON.stringify(bounded, null, 2)
  }
  if (text.length > MAX_MCP_OUTPUT_CHARS) {
    bounded = { ...metadata, preview: '' }
    text = JSON.stringify(bounded, null, 2)
  }
  return {
    value: bounded,
    structuredValue: {
      ...metadata,
      previewOmitted: true,
      previewChars: bounded.preview.length,
    },
    text,
  }
}

function sanitizeOptionalArguments(name, args) {
  if (args === null || args === undefined || typeof args !== 'object' || Array.isArray(args)) {
    return args
  }
  const schema = toolMap.get(name)?.inputSchema ?? {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const sanitized = { ...args }
  for (const [key, value] of Object.entries(sanitized)) {
    if (required.has(key)) continue
    if (value === null || value === ''
      || (Array.isArray(value) && value.length === 0)) {
      delete sanitized[key]
    }
  }
  return sanitized
}

function normalizeRootPath(name, args) {
  if (!['glob', 'grep', 'replace'].includes(name)) return args
  if (Object.prototype.hasOwnProperty.call(args, 'path') && args.path !== '') {
    return args
  }
  return { ...args, path: requestRoot(args) }
}

function toolCall(name, args) {
  if (!toolMap.has(name)) {
    throw new Error(`unknown tool: ${name}`)
  }
  if (args !== null && args !== undefined
    && (typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('tool arguments must be an object')
  }
  const sanitized = normalizeRootPath(
    name,
    sanitizeOptionalArguments(name, args ?? {}),
  )
  const guard = guardLargeJsonRead(name, sanitized)
  if (guard !== undefined) return Promise.resolve(guard)
  if (name === 'json_query') return Promise.resolve(jsonQuery(sanitized))
  return invokeWorker(name, sanitized)
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'dsh-ops',
        version: ADAPTER_VERSION,
      },
      instructions:
        'dsh-ops native file tools. Pass absolute local paths. '
        + 'Use json_query for large or minified JSON; read_files and inspect_local_file reject it. '
        + 'Every MCP response is capped at 20000 characters; use bounded pages instead of retrying. '
        + 'Failures are returned as structured values and may set isError. '
        + 'Mutation tools use content revisions and Codex approval prompts.',
    })
    return
  }

  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    sendResult(id, {})
    return
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: [...toolMap.values()] })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (typeof name !== 'string') {
      sendError(id, -32602, 'tools/call requires a tool name')
      return
    }
    try {
      const value = await toolCall(name, params?.arguments)
      const failed = value.status === 'error' || value.status === 'rejected'
      const bounded = boundedToolResponse(name, value)
      sendResult(id, {
        content: [{ type: 'text', text: bounded.text }],
        structuredContent: bounded.structuredValue,
        isError: failed,
      })
    } catch (error) {
      const failure = boundedToolResponse(name, {
        status: 'error',
        phase: 'execute',
        message: String(error?.message ?? error),
      })
      sendResult(id, {
        content: [{
          type: 'text',
          text: failure.text,
        }],
        structuredContent: failure.structuredValue,
        isError: true,
      })
    }
    return
  }
  if (method === 'shutdown') {
    sendResult(id, null)
    return
  }
  if (method === 'notifications/cancelled') return
  if (method === 'exit') process.exit(0)

  if (isRequest) sendError(id, -32601, `method not found: ${String(method)}`)
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

input.on('line', line => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    sendError(null, -32700, 'invalid JSON')
    return
  }
  handle(message).catch(error => {
    if (message.id !== undefined && message.id !== null) {
      sendError(message.id, -32603, String(error?.message ?? error))
    }
  })
})

input.once('close', () => process.exit(0))
