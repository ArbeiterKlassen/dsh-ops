#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  REA_NODE_VERSION,
  REA_VERSION,
  formatReaResolutionFailure,
  reaInstallRoot,
  resolveReaRuntime,
} from './rea-runtime.mjs'

function bounded(text, limit = 12_000) {
  const value = String(text ?? '')
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${value.length - limit} characters]`
}

function npmCommand(args) {
  const npmCli = process.env.npm_execpath
  if (
    typeof npmCli === 'string'
    && /\.(?:c?js|mjs)$/i.test(npmCli)
    && fs.existsSync(npmCli)
  ) {
    return {
      command: process.execPath,
      args: [npmCli, ...args],
    }
  }

  const adjacentCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  if (fs.existsSync(adjacentCli)) {
    return {
      command: process.execPath,
      args: [adjacentCli, ...args],
    }
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    shell: process.platform === 'win32',
  }
}

const installRoot = reaInstallRoot()
fs.mkdirSync(installRoot, { recursive: true })

const existing = resolveReaRuntime()
if (existing.node !== undefined && existing.entry !== undefined) {
  process.stdout.write(JSON.stringify({
    status: 'ready',
    reaVersion: REA_VERSION,
    nodeVersion: existing.node.version,
    node: existing.node.file,
    entry: existing.entry.file,
    installRoot,
  }, null, 2))
  process.exit(0)
}

const installArgs = [
  'install',
  '--prefix',
  installRoot,
  '--no-audit',
  '--no-fund',
  '--save-exact',
  `node@${REA_NODE_VERSION}`,
  `rea-agents@${REA_VERSION}`,
]
const launcher = npmCommand(installArgs)
const result = spawnSync(launcher.command, launcher.args, {
  cwd: installRoot,
  env: process.env,
  encoding: 'utf8',
  timeout: 300_000,
  maxBuffer: 1024 * 1024,
  shell: launcher.shell === true,
  windowsHide: true,
})

if (result.error !== undefined || result.status !== 0) {
  process.stderr.write(bounded(result.stdout))
  process.stderr.write(bounded(result.stderr))
  process.stderr.write(
    `\nREA bootstrap failed: ${String(result.error?.message ?? `exit ${result.status}`)}\n`,
  )
  process.exit(result.status ?? 1)
}

const resolved = resolveReaRuntime()
if (resolved.node === undefined || resolved.entry === undefined) {
  process.stderr.write(`${formatReaResolutionFailure(resolved)}\n`)
  process.exit(2)
}

process.stdout.write(JSON.stringify({
  status: 'installed',
  reaVersion: REA_VERSION,
  nodeVersion: resolved.node.version,
  node: resolved.node.file,
  entry: resolved.entry.file,
  installRoot,
}, null, 2))
