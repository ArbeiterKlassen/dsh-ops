#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, 'native-mcp.mjs')
const root = path.resolve(here, '..')

const child = spawn(process.execPath, [server], {
  cwd: root,
  env: {
    ...process.env,
    DSH_OPS_WORKSPACE_ROOT: root,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let nextId = 1
let buffer = ''
const pending = new Map()

child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => {
  for (const line of String(chunk).split('\n')) {
    if (line.trim() !== '') process.stderr.write(`[native] ${line}\n`)
  }
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    const message = JSON.parse(line)
    const entry = pending.get(message.id)
    if (entry === undefined) continue
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }
})

function request(method, params = {}) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-ops-codex-smoke', version: '0.4.6' },
  })
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
  )

  const listed = await request('tools/list', {})
  const tools = listed.tools ?? []
  console.log(JSON.stringify({
    server: init.serverInfo,
    tools: tools.map(tool => tool.name),
  }, null, 2))

  const files = await request('tools/call', {
    name: 'glob',
    arguments: {
      path: root,
      pattern: ['scripts/**/*.mjs'],
      limit: 20,
      sort: 'path',
    },
  })
  const filesValue = files.structuredContent
    ?? JSON.parse(files.content?.[0]?.text ?? '{}')
  if (filesValue.status !== 'completed' || !Array.isArray(filesValue.items)) {
    throw new Error(`glob smoke failed: ${JSON.stringify(filesValue)}`)
  }
  console.log(`glob: ${filesValue.items.length} MCP files`)

  const stat = await request('tools/call', {
    name: 'stat',
    arguments: {
      path: path.join(root, 'plugin.json'),
    },
  })
  const statValue = stat.structuredContent
    ?? JSON.parse(stat.content?.[0]?.text ?? '{}')
  if (statValue.status !== 'completed' || typeof statValue.revision !== 'string') {
    throw new Error(`stat smoke failed: ${JSON.stringify(statValue)}`)
  }
  console.log(`stat: ${statValue.revision.slice(0, 12)}`)

  const dryRun = await request('tools/call', {
    name: 'replace',
    arguments: {
      path: root,
      pattern: '"version": "0.4.6"',
      replacement: '"version": "0.4.6"',
      glob: ['plugin.json'],
      maxReplacements: 1,
      dryRun: true,
    },
  })
  const dryRunValue = dryRun.structuredContent
    ?? JSON.parse(dryRun.content?.[0]?.text ?? '{}')
  if (dryRunValue.status !== 'completed' || dryRunValue.dryRun !== true) {
    throw new Error(`replace dry-run smoke failed: ${JSON.stringify(dryRunValue)}`)
  }
  console.log('replace: dry-run completed')
} finally {
  child.stdin.end()
  child.kill()
}
