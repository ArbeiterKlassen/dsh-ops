#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import readline from 'node:readline'
import { credentialRoots } from '../vendor/credential-policy.js'
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

const TOOL_ORDER = [
  'inspect_local_file',
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

function toolCall(name, args) {
  if (!toolMap.has(name)) {
    throw new Error(`unknown tool: ${name}`)
  }
  if (args !== null && args !== undefined
    && (typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('tool arguments must be an object')
  }
  return invokeWorker(name, args ?? {})
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
      const text = JSON.stringify(value, null, 2)
      const failed = value.status === 'error' || value.status === 'rejected'
      sendResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: value,
        isError: failed,
      })
    } catch (error) {
      sendResult(id, {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            phase: 'execute',
            message: String(error?.message ?? error),
          }, null, 2),
        }],
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
