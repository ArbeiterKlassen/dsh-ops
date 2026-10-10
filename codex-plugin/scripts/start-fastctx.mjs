#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  PLUGIN_ROOT,
  formatResolutionFailure,
  resolveBash,
  resolveFastctxBinary,
  scrubChildEnv,
  truthy,
} from './runtime.mjs'

const requestedShell = process.argv.includes('--enable-shell')
  || truthy(process.env.DSH_OPS_ENABLE_SHELL)

const runtime = resolveFastctxBinary()
if (runtime.file === undefined) {
  console.error(formatResolutionFailure(
    runtime,
    'FastCtx executable',
  ))
  console.error('Run `node scripts/bootstrap-fastctx.mjs` inside the plugin, or set DSH_OPS_FASTCTX_BIN.')
  process.exit(2)
}

const env = scrubChildEnv()
env.FASTCTX_NO_PARENT_WATCH = '0'

let enableShell = requestedShell
let bash
if (enableShell) {
  bash = resolveBash()
  if (bash.file === undefined) {
    console.error(formatResolutionFailure(bash, 'bash executable'))
    console.error('FastCtx shell tools stay disabled; set DSH_OPS_BASH_PATH or install Git for Windows.')
    enableShell = false
  } else {
    env.FASTCTX_BASH = bash.file
  }
}

if (!enableShell) {
  env.FASTCTX_BASH = path.join(PLUGIN_ROOT, '.disabled-system-shell', 'bash.exe')
}

const args = ['serve']
if (enableShell) args.push('--enable-shell')

console.error(
  `[dsh-ops-codex] FastCtx from ${runtime.source}; shell tools ${enableShell ? 'enabled' : 'disabled'}.`,
)

const child = spawn(runtime.file, args, {
  stdio: 'inherit',
  windowsHide: true,
  env,
})

child.once('error', error => {
  console.error(`[dsh-ops-codex] FastCtx failed to start: ${error.message}`)
  process.exit(1)
})

child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}
