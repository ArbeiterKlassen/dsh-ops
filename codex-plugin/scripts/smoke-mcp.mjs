#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(here, 'start-fastctx.mjs')
const root = path.resolve(here, '..')
const enableShell = process.argv.includes('--enable-shell')
  || /^(1|true|yes|on)$/i.test(String(process.env.DSH_OPS_ENABLE_SHELL ?? '').trim())

const child = spawn(process.execPath, [launcher, ...(enableShell ? ['--enable-shell'] : [])], {
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
  for (const line of String(chunk).split('\n')) {
    if (line.trim() !== '') process.stderr.write(`[fastctx] ${line}\n`)
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
    clientInfo: { name: 'dsh-ops-codex-smoke', version: '0.1.0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  const listed = await request('tools/list', {})
  const tools = listed.tools ?? []
  console.log(JSON.stringify({
    server: init.serverInfo,
    instructions: init.instructions,
    tools: tools.map(tool => tool.name),
  }, null, 2))

  if (tools.some(tool => tool.name === 'run')) {
    const run = await request('tools/call', {
      name: 'run',
      arguments: {
        command: 'printf dsh-ops-smoke-shell-ok',
      },
    })
    console.log('run:', JSON.stringify(run.content?.[0]?.text ?? run))
  }

  const files = await request('tools/call', {
    name: 'glob',
    arguments: {
      pattern: ['**/*.mjs'],
      path: root,
      limit: 20,
      sort: 'path',
    },
  })
  console.log('glob:', JSON.stringify(files.content?.[0]?.text ?? files))
} finally {
  child.stdin.end()
  child.kill()
}
