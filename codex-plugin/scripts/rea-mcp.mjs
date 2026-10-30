#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { credentialPath, credentialRefusal } from '../vendor/credential-policy.js'
import {
  REA_VERSION,
  formatReaResolutionFailure,
  reaRuntimeRoot,
  resolveReaRuntime,
} from './rea-runtime.mjs'
import { scrubChildEnv } from './runtime.mjs'

const ENTRY_OPERATIONS = Object.freeze([
  'open_binary',
  'close_binary',
  'binary_overview',
  'analyze_javascript_application',
  'inspect_managed_artifact',
  'inspect_artifact',
  'list_browser_targets',
  'list_electron_targets',
  'export_evidence_bundle',
])
const OPERATION_SET = new Set(ENTRY_OPERATIONS)
const MAX_OUTPUT_CHARS = 20_000
const MAX_PREVIEW_CHARS = 12_000
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_DOWNSTREAM_LINE_CHARS = 32 * 1024 * 1024
const SERVER_NAME = 'rea'
const SERVER_VERSION = '0.1.0'

let connectionPromise
let downstream

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

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

function boundedText(value, limit = MAX_OUTPUT_CHARS) {
  const text = String(value ?? '')
  if (text.length <= limit) return { text, truncated: false }
  return {
    text: `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`,
    truncated: true,
  }
}

function requestCredentialCheck(value, field = 'arguments') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = requestCredentialCheck(item, `${field}[${index}]`)
      if (result !== undefined) return result
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /(?:^|_)path$/i.test(key)) {
      const verdict = credentialPath(item)
      if (verdict.denied) {
        return {
          field: `${field}.${key}`,
          ...credentialRefusal(item, verdict.matched),
        }
      }
    }
    const result = requestCredentialCheck(item, `${field}.${key}`)
    if (result !== undefined) return result
  }
  return undefined
}

function startDownstream() {
  const runtime = resolveReaRuntime()
  if (runtime.node === undefined || runtime.entry === undefined) {
    throw new Error(formatReaResolutionFailure(runtime))
  }

  fs.mkdirSync(reaRuntimeRoot(), { recursive: true })
  const child = spawn(runtime.node.file, [runtime.entry.file, 'mcp'], {
    cwd: reaRuntimeRoot(),
    env: {
      ...scrubChildEnv(),
      REA_MCP_INPUT_SCHEMA_PROFILE: 'compact',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const pending = new Map()
  let nextId = 1
  let closed = false
  let bufferChars = 0

  function failPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    const lines = String(chunk).split(/\r?\n/).filter(line => line.trim() !== '')
    for (const line of lines.slice(0, 5)) {
      process.stderr.write(`[rea] ${line.slice(0, 2_000)}\n`)
    }
  })

  const lines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })
  lines.on('line', line => {
    bufferChars = 0
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write('[rea] ignored malformed downstream JSON\n')
      return
    }
    if (message.id === undefined || message.id === null) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) {
      entry.reject(new Error(String(message.error.message ?? 'REA request failed')))
    } else {
      entry.resolve(message.result)
    }
  })
  child.stdout.on('data', chunk => {
    bufferChars += chunk.length
    if (bufferChars > MAX_DOWNSTREAM_LINE_CHARS) {
      child.kill()
      failPending(new Error('REA emitted an MCP message above 32 MiB'))
    }
  })

  child.once('error', error => {
    closed = true
    connectionPromise = undefined
    downstream = undefined
    failPending(error)
  })
  child.once('close', code => {
    closed = true
    connectionPromise = undefined
    downstream = undefined
    failPending(new Error(`REA MCP process exited ${String(code)}`))
  })

  function request(method, params = {}, timeoutMs = 120_000) {
    if (closed) {
      return Promise.reject(new Error('REA MCP process is not running'))
    }
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`REA request exceeded ${timeoutMs} ms; it may still be running`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  return (async () => {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'dsh-ops-codex-rea',
        version: SERVER_VERSION,
      },
    }, 30_000)
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })}\n`,
    )
    const listed = await request('tools/list', {}, 30_000)
    return {
      runtime,
      child,
      request,
      initialized,
      toolNames: new Set((listed.tools ?? []).map(tool => tool.name)),
    }
  })()
}

async function getDownstream() {
  if (connectionPromise === undefined) {
    connectionPromise = startDownstream().catch(error => {
      connectionPromise = undefined
      throw error
    })
  }
  downstream = await connectionPromise
  return downstream
}

function compactDownstreamResult(operation, result, elapsedMs) {
  const content = Array.isArray(result?.content)
    ? result.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('\n')
    : ''
  const fallback = result?.structuredContent === undefined
    ? ''
    : jsonText(result.structuredContent)
  const raw = content || fallback || jsonText(result ?? {})
  const isError = result?.isError === true

  if (raw.length <= MAX_OUTPUT_CHARS) {
    return {
      text: raw,
      isError,
    }
  }

  const resultsDir = path.join(reaRuntimeRoot(), 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeOperation = operation.replace(/[^a-z0-9_-]/gi, '_')
  const outputPath = path.join(resultsDir, `${stamp}-${safeOperation}.json`)
  fs.writeFileSync(outputPath, raw, 'utf8')

  return {
    text: jsonText({
      status: 'truncated',
      operation,
      isError,
      elapsedMs,
      originalChars: raw.length,
      outputPath,
      nextAction:
        'Inspect only selected fields from outputPath with json_query, or request a narrower operation.',
      preview: raw.slice(0, MAX_PREVIEW_CHARS),
    }),
    isError,
  }
}

async function invoke(args) {
  const operation = String(args?.operation ?? '')
  if (!OPERATION_SET.has(operation)) {
    return {
      text: jsonText({
        status: 'rejected',
        code: 'OPERATION_NOT_ALLOWED',
        operation,
        allowed: ENTRY_OPERATIONS,
      }),
      isError: true,
    }
  }

  const input = args?.arguments ?? {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      text: jsonText({
        status: 'rejected',
        code: 'ARGUMENTS_NOT_OBJECT',
      }),
      isError: true,
    }
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(input))
  if (inputBytes > MAX_ARGUMENT_BYTES) {
    return {
      text: jsonText({
        status: 'rejected',
        code: 'ARGUMENTS_TOO_LARGE',
        actualBytes: inputBytes,
        limitBytes: MAX_ARGUMENT_BYTES,
      }),
      isError: true,
    }
  }

  const credential = requestCredentialCheck(input)
  if (credential !== undefined) {
    return {
      text: jsonText({
        status: 'rejected',
        code: credential.code,
        field: credential.field,
        message: credential.message,
        nextAction: credential.nextAction,
      }),
      isError: true,
    }
  }

  const timeoutValue = Number(args?.timeout_ms ?? 120_000)
  const timeoutMs = Number.isFinite(timeoutValue)
    ? Math.min(600_000, Math.max(1_000, Math.trunc(timeoutValue)))
    : 120_000
  const started = Date.now()
  try {
    const runtime = await getDownstream()
    if (!runtime.toolNames.has(operation)) {
      throw new Error(`REA ${REA_VERSION} does not advertise ${operation}`)
    }
    const result = await runtime.request('tools/call', {
      name: operation,
      arguments: input,
    }, timeoutMs)
    return compactDownstreamResult(operation, result, Date.now() - started)
  } catch (error) {
    return {
      text: jsonText({
        status: 'error',
        operation,
        elapsedMs: Date.now() - started,
        message: String(error?.message ?? error),
      }),
      isError: true,
    }
  }
}

async function status() {
  const runtime = resolveReaRuntime()
  if (runtime.node === undefined || runtime.entry === undefined) {
    return {
      text: jsonText({
        status: 'unavailable',
        message: formatReaResolutionFailure(runtime),
      }),
      isError: true,
    }
  }
  try {
    const active = await getDownstream()
    return {
      text: jsonText({
        status: 'ready',
        server: active.initialized?.serverInfo,
        node: runtime.node.file,
        nodeVersion: runtime.node.version,
        entry: runtime.entry.file,
        advertisedTools: active.toolNames.size,
        exposedOperations: ENTRY_OPERATIONS,
      }),
      isError: false,
    }
  } catch (error) {
    return {
      text: jsonText({
        status: 'error',
        message: String(error?.message ?? error),
      }),
      isError: true,
    }
  }
}

function toolDefinitions() {
  return [
    {
      name: 'rea_invoke',
      description:
        'Invoke one allowlisted REA entry operation against a local artifact or user-owned runtime target. '
        + 'Results above 20000 characters are saved locally and returned as a bounded summary.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ENTRY_OPERATIONS,
          },
          arguments: {
            type: 'object',
            description: 'Arguments validated by the pinned REA 6.8.0 server.',
            default: {},
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1_000,
            maximum: 600_000,
            default: 120_000,
          },
        },
        required: ['operation'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: 'rea_status',
      description:
        'Report the pinned REA runtime, managed Node version, REA server identity, and exposed entry operations.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ]
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
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        'Pinned REA 6.8.0 gateway. Use rea_status first. '
        + 'Use rea_invoke only for the nine advertised entry operations. '
        + 'This adapter does not expose all 229 REA tools. Large results are saved locally.',
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    sendResult(id, {})
    return
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: toolDefinitions() })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (name !== 'rea_invoke' && name !== 'rea_status') {
      sendError(id, -32602, `unknown tool: ${String(name)}`)
      return
    }
    try {
      const result = name === 'rea_status'
        ? await status()
        : await invoke(params?.arguments ?? {})
      const bounded = boundedText(result.text)
      sendResult(id, {
        content: [{ type: 'text', text: bounded.text }],
        isError: result.isError,
      })
    } catch (error) {
      sendResult(id, {
        content: [{ type: 'text', text: String(error?.message ?? error) }],
        isError: true,
      })
    }
    return
  }
  if (method === 'shutdown') {
    downstream?.child.kill()
    sendResult(id, null)
    return
  }
  if (method === 'notifications/cancelled') return
  if (method === 'exit') {
    downstream?.child.kill()
    process.exit(0)
  }
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
input.once('close', () => {
  downstream?.child.kill()
  process.exit(0)
})
