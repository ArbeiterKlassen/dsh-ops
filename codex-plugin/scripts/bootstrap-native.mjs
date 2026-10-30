#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  WORKER_VERSION,
  bundledWorker,
  formatResolutionFailure,
  resolveWorkerBinary,
} from './runtime.mjs'

function probe(file) {
  const result = spawnSync(file, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  if (result.error !== undefined && result.error !== null) throw result.error
  if (result.status !== 0) {
    throw new Error(`${file} --version exited with status ${result.status}`)
  }
  return String(result.stdout ?? '').trim()
}

function verifyProvenance(binary) {
  const receipt = path.join(path.dirname(binary), 'provenance.json')
  if (!fs.existsSync(receipt)) {
    console.warn(`No provenance receipt beside ${binary}; version probe remains authoritative.`)
    return
  }
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  if (value.version !== WORKER_VERSION || value.target !== `${process.platform}-${process.arch}`) {
    throw new Error(`Worker provenance mismatch beside ${binary}`)
  }
  const digest = createHash('sha256').update(fs.readFileSync(binary)).digest('hex')
  if (typeof value.sha256 === 'string' && value.sha256 !== digest) {
    throw new Error(`Worker SHA-256 does not match ${receipt}`)
  }
  console.log(`Provenance verified: ${digest}`)
}

const bundled = bundledWorker()
if (!fs.existsSync(bundled)) {
  const resolution = resolveWorkerBinary()
  console.error(formatResolutionFailure(resolution, 'dsh-ops worker'))
  console.error(
    `This plugin build carries ${process.platform}-${process.arch}; `
    + 'set DSH_OPS_WORKER_BIN for another compatible worker.',
  )
  process.exit(2)
}

verifyProvenance(bundled)
console.log(`dsh-ops worker available: ${bundled}`)
console.log(probe(bundled))
