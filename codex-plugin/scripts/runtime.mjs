import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADAPTER_VERSION = '0.4.7'
export const WORKER_VERSION = '0.4.4'

/** Managed-runtime version override; the bundled receipt stays authoritative. */
export function workerVersion(env = process.env) {
  const value = env.DSH_OPS_WORKER_VERSION
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : WORKER_VERSION
}
export const WORKER_EXECUTABLE = process.platform === 'win32'
  ? 'dsh-ops-worker.exe'
  : 'dsh-ops-worker'

export const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function codexHome(env = process.env) {
  const configured = env.CODEX_HOME
  return configured !== undefined && configured.trim() !== ''
    ? path.resolve(configured)
    : path.join(os.homedir(), '.codex')
}

export function bundledWorker(
  env = process.env,
  platform = process.platform,
  arch = process.arch,
) {
  return path.join(
    PLUGIN_ROOT,
    'worker',
    platformKey(platform, arch),
    platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker',
  )
}

export function managedWorker(env = process.env) {
  return path.join(
    codexHome(env),
    'dsh-ops',
    'native',
    workerVersion(env),
    WORKER_EXECUTABLE,
  )
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

export function resolveWorkerBinary(env = process.env) {
  const candidates = []
  const add = (source, file) => {
    if (file === undefined || file === null || String(file).trim() === '') return
    candidates.push({ source, file: path.resolve(String(file)) })
  }

  add('DSH_OPS_WORKER_BIN', env.DSH_OPS_WORKER_BIN)
  add('managed runtime', managedWorker(env))
  add('bundled runtime', bundledWorker(env))
  add('PATH', findOnPath(WORKER_EXECUTABLE, env))

  for (const candidate of candidates) {
    if (isFile(candidate.file)) return { ...candidate, tried: candidates }
  }
  return { tried: candidates }
}

export function workspaceRoot(env = process.env) {
  for (const value of [
    env.DSH_OPS_WORKSPACE_ROOT,
    env.CODEX_WORKSPACE_ROOT,
    env.PWD,
    process.cwd(),
  ]) {
    if (typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value)) {
      return path.resolve(value)
    }
  }
  return process.cwd()
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

export function formatResolutionFailure(resolution, label) {
  const lines = [`${label} could not be found.`]
  for (const candidate of resolution.tried ?? []) {
    lines.push(`  - ${candidate.source}: ${candidate.file}`)
  }
  return lines.join('\n')
}
