#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FASTCTX_EXECUTABLE,
  FASTCTX_PACKAGE,
  FASTCTX_VERSION,
  managedBinary,
  runtimeRoot,
} from './runtime.mjs'

function parseArgs(argv) {
  const result = { force: false, fromTarball: undefined, registry: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--force') result.force = true
    else if (value === '--from-tarball') result.fromTarball = argv[++index]
    else if (value === '--registry') result.registry = argv[++index]
    else throw new Error(`unknown argument: ${value}`)
  }
  return result
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    shell: options.shell ?? false,
    env: process.env,
  })
  if (result.error !== undefined && result.error !== null) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

function probe(file) {
  const result = spawnSync(file, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  if (result.error !== undefined && result.error !== null) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${file} --version exited with status ${result.status}`)
  }
  return String(result.stdout ?? '').trim()
}

function copyLicenseFiles(packageRoot, targetRoot) {
  const licenses = path.join(targetRoot, 'licenses')
  fs.mkdirSync(licenses, { recursive: true })
  for (const name of [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_LICENSES.md',
    'THIRD_PARTY_LICENSES_RUST.md',
    'FORK.md',
    'UPSTREAM.md',
    'provenance.json',
  ]) {
    const source = path.join(packageRoot, name)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(licenses, name))
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = runtimeRoot()
  fs.mkdirSync(root, { recursive: true })

  if (!options.force && fs.existsSync(managedBinary())) {
    console.log(`FastCtx already available: ${managedBinary()}`)
    console.log(probe(managedBinary()))
    return
  }

  let tarball = options.fromTarball === undefined
    ? undefined
    : path.resolve(options.fromTarball)
  let tempDir

  try {
    if (tarball === undefined) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-codex-fastctx-'))
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const args = [
        'pack',
        `${FASTCTX_PACKAGE}@${FASTCTX_VERSION}`,
        '--pack-destination',
        tempDir,
      ]
      if (options.registry !== undefined) args.push('--registry', options.registry)
      run(npm, args, { shell: process.platform === 'win32' })
      const packed = fs.readdirSync(tempDir).find(name => name.endsWith('.tgz'))
      if (packed === undefined) throw new Error('npm pack did not produce a tarball')
      tarball = path.join(tempDir, packed)
    }

    if (!fs.existsSync(tarball)) {
      throw new Error(`tarball does not exist: ${tarball}`)
    }

    const packageRoot = path.join(root, 'package')
    fs.rmSync(packageRoot, { recursive: true, force: true })
    run('tar', ['-xzf', tarball, '-C', root])

    const packagedBinary = path.join(packageRoot, 'bin', FASTCTX_EXECUTABLE)
    if (!fs.existsSync(packagedBinary)) {
      throw new Error(`tarball does not contain bin/${FASTCTX_EXECUTABLE}`)
    }

    try {
      fs.copyFileSync(packagedBinary, managedBinary())
    } catch (error) {
      const locked = error?.code === 'EBUSY' || error?.code === 'EPERM'
      if (!locked || !fs.existsSync(managedBinary())) throw error
      console.warn(
        `FastCtx is currently in use; kept the existing ${managedBinary()} and updated the unpacked package copy.`,
      )
    }
    copyLicenseFiles(packageRoot, root)
    const activeBinary = fs.existsSync(managedBinary()) ? managedBinary() : packagedBinary
    const version = probe(activeBinary)
    console.log(`FastCtx provisioned: ${activeBinary}`)
    console.log(version)
  } finally {
    if (tempDir !== undefined) fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main()
