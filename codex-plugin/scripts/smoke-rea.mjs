#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, 'rea-mcp.mjs')
const root = path.resolve(here, '..')
const child = spawn(process.execPath, [server], {
  cwd: root,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let nextId = 1
let buffer = ''
const pending = new Map()

child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim() !== '') process.stderr.write(`[rea-smoke] ${line}\n`)
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
    clientInfo: { name: 'dsh-ops-codex-rea-smoke', version: '0.4.6' },
  })
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
  )
  const listed = await request('tools/list')
  const status = await request('tools/call', {
    name: 'rea_status',
    arguments: {},
  })
  const text = status.content?.[0]?.text ?? ''
  if (status.isError === true) throw new Error(text)
  const value = JSON.parse(text)
  if (value.status !== 'ready' || value.server?.name !== 'rea') {
    throw new Error(`rea_status failed: ${text}`)
  }
  console.log(JSON.stringify({
    server: init.serverInfo,
    tools: listed.tools.map(tool => tool.name),
    rea: {
      status: value.status,
      version: value.server.version,
      nodeVersion: value.nodeVersion,
      advertisedTools: value.advertisedTools,
      exposedOperations: value.exposedOperations,
    },
  }, null, 2))
} finally {
  child.stdin.end()
  child.kill()
}
