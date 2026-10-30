import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { codexHome } from './runtime.mjs'

export const REA_VERSION = '6.8.0'
export const REA_NODE_VERSION = '24.22.1'

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim())
  return match === null
    ? undefined
    : match.slice(1).map(part => Number(part))
}

export function reaSupportsNode(value) {
  const parts = versionParts(value)
  if (parts === undefined) return false
  const [major, minor, patch] = parts
  if (major === 22) {
    return minor > 23 || (minor === 23 && patch >= 4)
  }
  if (major === 24) {
    return minor > 22 || (minor === 22 && patch >= 1)
  }
  if (major >= 26) {
    return minor > 12 || (minor === 12 && patch >= 1) || major > 26
  }
  return false
}

export function reaRuntimeRoot(env = process.env) {
  const configured = env.REA_HOME
  return typeof configured === 'string'
    && configured.trim() !== ''
    && path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.join(codexHome(env), 'dsh-ops', 'rea')
}

export function reaInstallRoot(env = process.env) {
  return path.join(reaRuntimeRoot(env), REA_VERSION)
}

export function reaPackageEntry(env = process.env) {
  return path.join(
    reaInstallRoot(env),
    'node_modules',
    'rea-agents',
    'scripts',
    'rea.mjs',
  )
}

export function managedReaNode(env = process.env) {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  return path.join(
    reaInstallRoot(env),
    'node_modules',
    'node',
    'bin',
    executable,
  )
}

function nodeVersion(node, env) {
  const result = spawnSync(node, ['--version'], {
    cwd: path.dirname(node),
    env,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  if (result.status !== 0) return undefined
  return String(result.stdout).trim()
}

export function resolveReaRuntime(env = process.env) {
  const tried = []
  const add = (source, file, explicit = false) => {
    if (typeof file !== 'string' || file.trim() === '') return
    tried.push({ source, file: path.resolve(file), explicit })
  }

  add('REA_NODE_BIN', env.REA_NODE_BIN, true)
  add('managed runtime', managedReaNode(env))
  add('current process', process.execPath)

  let node
  for (const candidate of tried) {
    if (!isFile(candidate.file)) continue
    const version = nodeVersion(candidate.file, env)
    candidate.version = version
    if (version !== undefined && (candidate.explicit || reaSupportsNode(version))) {
      node = { ...candidate, version }
      break
    }
  }

  const entryCandidates = []
  if (typeof env.REA_PACKAGE_ENTRY === 'string' && env.REA_PACKAGE_ENTRY.trim() !== '') {
    entryCandidates.push({
      source: 'REA_PACKAGE_ENTRY',
      file: path.resolve(env.REA_PACKAGE_ENTRY),
    })
  }
  entryCandidates.push({
    source: 'managed install',
    file: reaPackageEntry(env),
  })

  const entry = entryCandidates.find(candidate => isFile(candidate.file))
  return {
    node,
    entry,
    root: reaRuntimeRoot(env),
    installRoot: reaInstallRoot(env),
    tried,
    entryTried: entryCandidates,
  }
}

export function formatReaResolutionFailure(resolution) {
  const lines = ['REA 6.8.0 is not ready.']
  lines.push('Node candidates:')
  for (const candidate of resolution.tried) {
    lines.push(
      `  - ${candidate.source}: ${candidate.file}`
      + `${candidate.version === undefined ? '' : ` (${candidate.version})`}`,
    )
  }
  lines.push('REA entry candidates:')
  for (const candidate of resolution.entryTried) {
    lines.push(`  - ${candidate.source}: ${candidate.file}`)
  }
  lines.push('Run codex-plugin/scripts/rea-bootstrap.mjs to install the pinned runtime.')
  return lines.join('\n')
}
