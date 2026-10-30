#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, 'native-mcp.mjs')
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-json-query-'))
const fixture = path.join(fixtureDir, 'fixture.json')
const largeText = path.join(fixtureDir, 'large.txt')
const document = Array.from({ length: 1530 }, (_, index) => index === 1522
  ? {
      list: [
        { code: 401, indent: 0, parameters: ['plain'], pad: 'x'.repeat(100) },
        { code: 117, indent: 0, parameters: [1523], pad: 'x'.repeat(100) },
        { code: 117, indent: 0, parameters: [1524], pad: 'x'.repeat(100) },
        { code: 117, indent: 0, parameters: [1525], pad: 'x'.repeat(100) },
      ],
    }
  : { id: index, pad: 'x'.repeat(100) })
fs.writeFileSync(fixture, JSON.stringify(document), 'utf8')
fs.writeFileSync(
  largeText,
  Array.from({ length: 300 }, (_, index) => `${index}:${'x'.repeat(250)}`).join('\n'),
  'utf8',
)
const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
})

const pending = new Map()
const input = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  const promise = new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`))
    }, 15_000)
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return promise
}

const initialized = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'json-query-smoke', version: '1.0.0' },
})
if (initialized.error) throw new Error(JSON.stringify(initialized.error))

const listed = await request('tools/list', {})
const names = listed.result.tools.map(tool => tool.name)
if (!names.includes('json_query')) {
  throw new Error(`json_query missing from tools: ${names.join(', ')}`)
}

const called = await request('tools/call', {
  name: 'json_query',
  arguments: {
    path: fixture,
    selector: '[1522].list',
    where: { code: 117 },
    fields: ['code', 'indent', 'parameters'],
    context: 2,
    limit: 3,
    maxChars: 12000,
  },
})
if (called.error || called.result?.isError) {
  throw new Error(JSON.stringify(called))
}
const payload = called.result.structuredContent
if (payload.status !== 'completed' || !payload.items?.length) {
  throw new Error(`unexpected payload: ${JSON.stringify(payload)}`)
}
if (payload.matched < 2 || payload.returned > 3) {
  throw new Error(`bad bounds: ${JSON.stringify(payload)}`)
}

const partial = await request('tools/call', {
  name: 'json_query',
  arguments: {
    path: fixture,
    selector: '[1522].list',
    limit: 1,
    maxChars: 1000,
  },
})
const partialPayload = partial.result?.structuredContent
if (partial.error || partialPayload?.truncated !== true
  || partialPayload?.complete !== false) {
  throw new Error(
    `truncated json_query reported a complete result: ${JSON.stringify({
      rpcError: partial.error,
      complete: partialPayload?.complete,
      truncated: partialPayload?.truncated,
      returned: partialPayload?.returned,
      matched: partialPayload?.matched,
    })}`,
  )
}

const placeholderArgs = await request('tools/call', {
  name: 'glob',
  arguments: {
    path: '',
    pattern: ['scripts/**/*.mjs'],
    outputMode: '',
    sort: null,
    limit: null,
    continuation: '',
  },
})
const placeholderPayload = placeholderArgs.result?.structuredContent
if (placeholderArgs.error || placeholderPayload?.status !== 'completed'
  || !Array.isArray(placeholderPayload?.items)) {
  throw new Error(
    `optional placeholder arguments were not filtered: ${JSON.stringify({
      rpcError: placeholderArgs.error,
      status: placeholderPayload?.status,
      error: placeholderPayload?.error,
    })}`,
  )
}

const invalidPath = await request('tools/call', {
  name: 'glob',
  arguments: {
    path: 123,
    pattern: ['scripts/**/*.mjs'],
  },
})
const invalidPathPayload = invalidPath.result?.structuredContent
if (!invalidPath.result?.isError || invalidPathPayload?.status !== 'error') {
  throw new Error(
    `invalid non-empty path was silently normalized: ${JSON.stringify({
      isError: invalidPath.result?.isError,
      status: invalidPathPayload?.status,
    })}`,
  )
}

const blocked = await request('tools/call', {
  name: 'read_files',
  arguments: {
    files: [{ path: fixture, limit: 400 }],
  },
})
const blockedPayload = blocked.result?.structuredContent
if (blocked.error || blockedPayload?.phase !== 'preflight'
  || blockedPayload?.status !== 'rejected'
  || blockedPayload?.error?.code !== 'JSON_QUERY_REQUIRED') {
  throw new Error(`large JSON read was not blocked: ${JSON.stringify(blocked)}`)
}

const searched = await request('tools/call', {
  name: 'grep',
  arguments: {
    path: path.resolve(here, '..'),
    pattern: 'MAX_MCP_OUTPUT_CHARS',
    glob: ['scripts/**/*.mjs'],
    outputMode: 'summary',
    limit: 10,
  },
})
const searchPayload = searched.result?.structuredContent
if (searched.error || searchPayload?.status !== 'completed'
  || (searchPayload?.matches ?? 0) < 1) {
  throw new Error(
    `compact grep recipe failed: ${JSON.stringify({
      rpcError: searched.error,
      status: searchPayload?.status,
      matches: searchPayload?.matches,
      scanComplete: searchPayload?.scanComplete,
    })}`,
  )
}

const truncation = await request('tools/call', {
  name: 'read_files',
  arguments: {
    files: [{ path: largeText, offset: 1, limit: 300 }],
  },
})
const truncationPayload = truncation.result?.structuredContent
const truncationText = truncation.result?.content?.[0]?.text ?? ''
if (truncation.error || truncationPayload?.truncatedBy !== 'adapter-output-budget'
  || truncationText.length > 20_000) {
  throw new Error(
    'large tool output was not bounded: '
    + JSON.stringify({
      rpcError: truncation.error,
      isError: truncation.result?.isError,
      truncatedBy: truncationPayload?.truncatedBy,
      outputBudget: truncationPayload?.outputBudget,
      textChars: truncationText.length,
    }),
  )
}

console.log(JSON.stringify({
  tools: names.length,
  jsonQuery: true,
  jsonPartial: true,
  placeholderFiltered: true,
  invalidRootRejected: true,
  largeReadBlocked: true,
  compactSearch: true,
  outputBudget: truncationPayload.outputBudget,
  matched: payload.matched,
  returned: payload.returned,
  revision: payload.revision,
}, null, 2))

child.stdin.end()
fs.rmSync(fixtureDir, { recursive: true, force: true })
