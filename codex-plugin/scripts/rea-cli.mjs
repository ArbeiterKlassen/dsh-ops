#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  formatReaResolutionFailure,
  reaRuntimeRoot,
  resolveReaRuntime,
} from './rea-runtime.mjs'
import { scrubChildEnv } from './runtime.mjs'

const DENIED_COMMANDS = new Set([
  'mcp',
  'setup',
  'uninstall',
  'update',
])

function parseOwnOptions(argv) {
  const args = []
  let timeoutMs = 300_000
  let inputFile
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--') {
      args.push(...argv.slice(index + 1))
      break
    }
    if (value.startsWith('--timeout-ms=')) {
      timeoutMs = Number(value.slice('--timeout-ms='.length))
      continue
    }
    if (value === '--timeout-ms') {
      timeoutMs = Number(argv[++index])
      continue
    }
    if (value.startsWith('--input-file=')) {
      inputFile = value.slice('--input-file='.length)
      continue
    }
    if (value === '--input-file') {
      inputFile = argv[++index]
      continue
    }
    args.push(value)
  }
  return {
    args,
    timeoutMs: Number.isFinite(timeoutMs)
      ? Math.min(3_600_000, Math.max(1_000, Math.trunc(timeoutMs)))
      : 300_000,
    inputFile: inputFile === undefined ? undefined : path.resolve(inputFile),
  }
}

function previewFile(file, limit = 8_000) {
  try {
    const stat = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const actualLength = Math.min(stat.size, limit)
    const buffer = Buffer.alloc(actualLength)
    fs.readSync(fd, buffer, 0, actualLength, 0)
    fs.closeSync(fd)
    return {
      chars: stat.size,
      preview: buffer.toString('utf8'),
      truncated: stat.size > actualLength,
    }
  } catch {
    return { chars: 0, preview: '', truncated: false }
  }
}

const own = parseOwnOptions(process.argv.slice(2))
if (own.args.length === 0) {
  process.stderr.write(
    'Usage: node rea-cli.mjs [--timeout-ms=N] [--input-file=PATH] <rea-command> [...args]\n',
  )
  process.exit(2)
}

const command = own.args[0]
if (command === undefined) {
  process.stderr.write('A REA command is required.\n')
  process.exit(2)
}
if (DENIED_COMMANDS.has(command)) {
  process.stdout.write(JSON.stringify({
    status: 'rejected',
    code: 'COMMAND_NOT_ALLOWED',
    command,
    message: 'Installation and client-registration mutations are outside the bounded REA CLI wrapper.',
  }, null, 2))
  process.exit(2)
}

const runtime = resolveReaRuntime()
if (runtime.node === undefined || runtime.entry === undefined) {
  process.stderr.write(`${formatReaResolutionFailure(runtime)}\n`)
  process.exit(2)
}

const commandNamesPath = path.join(
  path.dirname(runtime.entry.file),
  '..',
  'dist',
  'cliCommandNames.js',
)
let commandNames
try {
  const module = await import(pathToFileURL(commandNamesPath))
  commandNames = module.CLI_COMMAND_NAMES
} catch (error) {
  process.stderr.write(`Could not read REA command catalog: ${String(error?.message ?? error)}\n`)
  process.exit(2)
}
if (!commandNames.includes(command) && command !== '--version' && command !== '--help') {
  process.stderr.write(`Unknown REA command: ${command}\n`)
  process.exit(2)
}

const runsDir = path.join(reaRuntimeRoot(), 'runs')
fs.mkdirSync(runsDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const safeCommand = command.replace(/[^a-z0-9_-]/gi, '_')
const stdoutPath = path.join(runsDir, `${stamp}-${safeCommand}.stdout.log`)
const stderrPath = path.join(runsDir, `${stamp}-${safeCommand}.stderr.log`)
const stdoutFd = fs.openSync(stdoutPath, 'w')
const stderrFd = fs.openSync(stderrPath, 'w')
const inputFd = own.inputFile === undefined ? undefined : fs.openSync(own.inputFile, 'r')

const child = spawn(runtime.node.file, [runtime.entry.file, ...own.args], {
  cwd: process.cwd(),
  env: scrubChildEnv(),
  stdio: [
    inputFd ?? 'ignore',
    stdoutFd,
    stderrFd,
  ],
  windowsHide: true,
})

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill()
}, own.timeoutMs)
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ code: 2, error }))
  child.once('close', (code, signal) => resolve({ code: code ?? 2, signal }))
})
clearTimeout(timer)
fs.closeSync(stdoutFd)
fs.closeSync(stderrFd)
if (inputFd !== undefined) fs.closeSync(inputFd)

const stdout = previewFile(stdoutPath)
const stderr = previewFile(stderrPath, 4_000)
process.stdout.write(JSON.stringify({
  status: result.code === 0 && !timedOut ? 'completed' : 'failed',
  command,
  exitCode: result.code,
  signal: result.signal,
  timedOut,
  timeoutMs: own.timeoutMs,
  stdoutPath,
  stderrPath,
  stdout,
  stderr,
}, null, 2))
process.exit(result.code === 0 && !timedOut ? 0 : result.code || 1)
