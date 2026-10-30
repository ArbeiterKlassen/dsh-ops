#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { credentialPath, credentialRefusal } from '../vendor/credential-policy.js'
import { workspaceRoot } from './runtime.mjs'

function parse(argv) {
  const values = {
    roots: [],
    paths: [],
    urls: [],
    allowRoots: [],
    allowHosts: [],
  }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      key === '--root'
      || key === '--path'
      || key === '--url'
      || key === '--allow-root'
      || key === '--allow-host'
    ) {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${key} requires a value`)
      }
      index++
      if (key === '--root') values.roots.push(value)
      if (key === '--path') values.paths.push(value)
      if (key === '--url') values.urls.push(value)
      if (key === '--allow-root') values.allowRoots.push(value)
      if (key === '--allow-host') values.allowHosts.push(value)
      continue
    }
    throw new Error(`unknown option: ${key}`)
  }
  return values
}

function realpathNearest(value) {
  let current = path.resolve(value)
  const tail = []
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(value)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative))
}

function hostAllowed(host, allowHosts) {
  const target = host.toLowerCase()
  return allowHosts.some(entry => {
    const allowed = entry.toLowerCase()
    return target === allowed || target.endsWith(`.${allowed}`)
  })
}

let parsed
try {
  parsed = parse(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${String(error?.message ?? error)}\n`)
  process.exit(2)
}

if (parsed.paths.length + parsed.urls.length > 200) {
  process.stderr.write('At most 200 scoped paths and URLs may be audited in one call.\n')
  process.exit(2)
}

const baseRoot = parsed.roots[0] === undefined
  ? workspaceRoot()
  : path.resolve(parsed.roots[0])
const allowedRoots = parsed.allowRoots.length === 0
  ? [baseRoot]
  : parsed.allowRoots.map(realpathNearest)
const allowHosts = parsed.allowHosts.map(value => value.trim()).filter(Boolean)

const paths = parsed.paths.map(input => {
  const canonical = realpathNearest(input)
  const credential = credentialPath(canonical)
  if (credential.denied) {
    return {
      input,
      canonical,
      allowed: false,
      reason: 'credential_location',
      message: credentialRefusal(canonical, credential.matched).message,
    }
  }
  const inScope = allowedRoots.some(root => within(root, canonical))
  return {
    input,
    canonical,
    allowed: inScope,
    reason: inScope ? 'inside_allowed_root' : 'outside_allowed_root',
  }
})

const urls = parsed.urls.map(input => {
  let target
  try {
    target = new URL(input)
  } catch {
    return {
      input,
      allowed: false,
      reason: 'invalid_url',
    }
  }
  if (target.username !== '' || target.password !== '') {
    return {
      input,
      origin: target.origin,
      allowed: false,
      reason: 'embedded_credentials',
    }
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return {
      input,
      origin: target.origin,
      allowed: false,
      reason: 'unsupported_scheme',
    }
  }
  const allowed = hostAllowed(target.host, allowHosts)
  return {
    input,
    origin: target.origin,
    host: target.host,
    allowed,
    reason: allowed
      ? 'host_allowed'
      : allowHosts.length === 0
        ? 'no_host_scope_configured'
        : 'host_outside_allowlist',
  }
})

const allAllowed = [...paths, ...urls].every(item => item.allowed)
process.stdout.write(JSON.stringify({
  status: allAllowed ? 'allowed' : 'denied',
  baseRoot,
  allowedRoots,
  allowHosts,
  paths,
  urls,
}, null, 2))
process.exit(allowedRoots.length > 0 && parsed.paths.every(item => item !== undefined)
  && allAllowed ? 0 : 1)
