import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FASTCTX_VERSION = '0.2.1'
export const FASTCTX_PACKAGE = '@dsh-ops/fastctx-win32-x64'
export const FASTCTX_EXECUTABLE = 'fastctx.exe'

export const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

export function codexHome(env = process.env) {
  const configured = env.CODEX_HOME
  return configured !== undefined && configured.trim() !== ''
    ? path.resolve(configured)
    : path.join(os.homedir(), '.codex')
}

export function runtimeRoot(env = process.env) {
  return path.join(codexHome(env), 'dsh-ops', 'fastctx', FASTCTX_VERSION)
}

export function managedBinary(env = process.env) {
  return path.join(runtimeRoot(env), FASTCTX_EXECUTABLE)
}

export function unpackedPackageBinary(env = process.env) {
  return path.join(runtimeRoot(env), 'package', 'bin', FASTCTX_EXECUTABLE)
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function findOnPath(name, env = process.env) {
  const rawPath = env.PATH ?? env.Path ?? ''
  for (const entry of rawPath.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (directory === '') continue
    const candidate = path.join(directory, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

export function resolveFastctxBinary(env = process.env) {
  const candidates = []
  const add = (source, file) => {
    if (file === undefined || file === null || String(file).trim() === '') return
    candidates.push({ source, file: path.resolve(String(file)) })
  }

  add('DSH_OPS_FASTCTX_BIN', env.DSH_OPS_FASTCTX_BIN)
  add('managed runtime', managedBinary(env))
  add('unpacked npm package', unpackedPackageBinary(env))
  add(
    'plugin node_modules',
    path.join(PLUGIN_ROOT, 'node_modules', FASTCTX_PACKAGE, 'bin', FASTCTX_EXECUTABLE),
  )
  add(
    'repository node_modules',
    path.join(PLUGIN_ROOT, '..', 'node_modules', FASTCTX_PACKAGE, 'bin', FASTCTX_EXECUTABLE),
  )
  add('PATH', findOnPath(FASTCTX_EXECUTABLE, env))

  for (const candidate of candidates) {
    if (isFile(candidate.file)) return { ...candidate, tried: candidates }
  }
  return { tried: candidates }
}

export function resolveBash(env = process.env) {
  const candidates = []
  const add = (source, file) => {
    if (file === undefined || file === null || String(file).trim() === '') return
    candidates.push({ source, file: path.resolve(String(file)) })
  }

  add('DSH_OPS_BASH_PATH', env.DSH_OPS_BASH_PATH)
  add('managed bash runtime', path.join(codexHome(env), 'dsh-ops', 'bash', 'bash.exe'))
  add(
    'Git for Windows',
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  )
  add('PATH', findOnPath('bash.exe', env))

  for (const candidate of candidates) {
    if (isFile(candidate.file)) return { ...candidate, tried: candidates }
  }
  return { tried: candidates }
}

export function scrubChildEnv(env = process.env) {
  const clean = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    clean[key] = value
  }
  return clean
}

export function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

export function formatResolutionFailure(resolution, label) {
  const lines = [`${label} could not be found.`]
  for (const candidate of resolution.tried ?? []) {
    lines.push(`  - ${candidate.source}: ${candidate.file}`)
  }
  return lines.join('\n')
}
