/**
 * The release scope: which native targets a gate demands, and which one it only
 * reports.
 *
 * Two different questions were being answered by one command. A release package
 * must carry every declared platform, and `scripts/build-platform-packages.mjs`
 * depends on a bare `check` to refuse an incomplete publish directory. A
 * one-host source build can only ever produce its own target, so validating it
 * has to be asked for explicitly (`check --staged`). When the two were tangled,
 * `npm run check:ptc-runtime` and `npm run verify:release` both failed on a
 * Linux-only build — the scripts named a target this host cannot build.
 *
 * `bin/check-release.mjs` additionally used to hard-code `os === ["win32"]`,
 * which is exactly the declaration PR #72 changed. A scope that lives in one
 * place and is asserted in another will drift again, so the closure now derives
 * the expected set from `package.json` and asserts it equals the resolver's
 * PLATFORMS.
 *
 * The fixtures carry synthetic binary headers — enough for the PE/ELF magic and
 * machine checks — so a scope test does not need a 3.6 MiB worker per case.
 *
 * @module dsh-ops/test/release-scope
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const NATIVE_RUNTIME = path.join(PACKAGE_ROOT, 'bin', 'native-runtime.mjs')
const CHECK_RELEASE = path.join(PACKAGE_ROOT, 'bin', 'check-release.mjs')
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version

/** A 64-bit little-endian x86-64 ELF header, and nothing else. */
function elfX64() {
  const bytes = Buffer.alloc(20)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes, 0)
  bytes[4] = 2                                  // ELFCLASS64
  bytes[5] = 1                                  // ELFDATA2LSB
  bytes.writeUInt16LE(62, 18)                   // EM_X86_64
  return bytes
}

/** A PE header claiming an x86-64 machine. */
function peX64() {
  const bytes = Buffer.alloc(0x48)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x40, 0x3c)               // e_lfanew
  bytes.writeUInt32LE(0x4550, 0x40)             // 'PE\0\0'
  bytes.writeUInt16LE(0x8664, 0x44)             // IMAGE_FILE_MACHINE_AMD64
  return bytes
}

const BINARIES = { 'win32-x64': () => ({ name: 'dsh-ops-worker.exe', bytes: peX64() }), 'linux-x64': () => ({ name: 'dsh-ops-worker', bytes: elfX64() }) }

/**
 * Materialise a package tree the gates can run against.
 * @param {string} dir - the package directory to fill.
 * @param {object} options - fixture inputs.
 * @param {string[]} [options.os] - `package.json` os.
 * @param {string[]} [options.cpu] - `package.json` cpu.
 * @param {string[]} [options.staged] - targets to stage under `runtime/`.
 * @param {object} [options.tamper] - replace a staged worker's bytes after its receipt is written.
 * @returns {string} the package directory.
 */
function makePackage(dir, { os = ['win32', 'linux'], cpu = ['x64'], staged = ['linux-x64'], tamper = null } = {}) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'lib', 'ptc'), { recursive: true })
  fs.copyFileSync(NATIVE_RUNTIME, path.join(dir, 'bin', 'native-runtime.mjs'))
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'lib', 'ptc', 'runtime.js'), path.join(dir, 'lib', 'ptc', 'runtime.js'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: VERSION, os, cpu }, null, 2))
  for (const target of staged) {
    const built = BINARIES[target]()
    const directory = path.join(dir, 'runtime', target)
    fs.mkdirSync(directory, { recursive: true })
    const destination = path.join(directory, built.name)
    fs.writeFileSync(destination, built.bytes)
    fs.chmodSync(destination, 0o755)
    fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify({
      version: VERSION, target, executable: built.name,
      sha256: createHash('sha256').update(built.bytes).digest('hex'),
      source: 'synthetic fixture',
    }, null, 2))
    if (target === tamper?.target) fs.writeFileSync(destination, Buffer.concat([built.bytes, Buffer.from('tampered')]))
  }
  return dir
}

/**
 * Run one of the two gate scripts as a child process.
 * @param {string} script - absolute script path.
 * @param {string[]} args - arguments.
 * @param {NodeJS.ProcessEnv} [env] - extra environment.
 * @returns {{status: number|null, out: string}} the exit status and merged output.
 */
function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

await test('a bare check still demands every declared platform, so an incomplete release cannot pass', async () => {
  await withTempDir('scope-partial', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    const result = run(path.join(pkg, 'bin', 'native-runtime.mjs'), ['check', '--root', pkg])
    assert.notEqual(result.status, 0, 'a one-target package must not satisfy a release check')
    assert.match(result.out, /win32-x64/u, 'the failure names the missing target')
  })
})

await test('check --staged validates the target this host actually built', async () => {
  await withTempDir('scope-staged', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    const result = run(path.join(pkg, 'bin', 'native-runtime.mjs'), ['check', '--staged', '--root', pkg])
    assert.equal(result.status, 0, `check --staged failed:\n${result.out}`)
    assert.match(result.out, /linux-x64: \d+ bytes/u, 'the staged target is reported')
    assert.match(result.out, /Validated 1 native runtime/u, 'exactly one target was validated')
  })
})

await test('a half-staged runtime is reported instead of being skipped as absent', async () => {
  await withTempDir('scope-half-staged', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    // A worker in place with no receipt: `--staged` used to pass this by, calling the
    // target absent while its binary sat in the package.
    const half = path.join(pkg, 'runtime', 'win32-x64')
    fs.mkdirSync(half, { recursive: true })
    fs.writeFileSync(path.join(half, 'dsh-ops-worker.exe'), peX64())
    const result = run(path.join(pkg, 'bin', 'native-runtime.mjs'), ['check', '--staged', '--root', pkg])
    assert.notEqual(result.status, 0, 'a worker without its receipt is not a staged target')
    assert.match(result.out, /Half-staged runtime/u)
    assert.match(result.out, /win32-x64/u, 'the message names the target that is half staged')
  })
})

await test('a --root without a package manifest is named rather than leaked as ENOENT', async () => {
  await withTempDir('scope-no-root', (dir) => {
    const result = run(NATIVE_RUNTIME, ['check', '--root', dir])
    assert.notEqual(result.status, 0, 'a root with no package.json cannot be validated')
    assert.match(result.out, /package manifest at .*package\.json could not be read/u)
  })
})

await test('check --staged reports an actionable failure when nothing is staged', async () => {
  await withTempDir('scope-empty', (dir) => {
    const pkg = makePackage(dir, { staged: [] })
    const result = run(path.join(pkg, 'bin', 'native-runtime.mjs'), ['check', '--staged', '--root', pkg])
    assert.notEqual(result.status, 0, 'an empty runtime directory cannot validate')
    assert.match(result.out, /No staged native runtime/u)
    assert.match(result.out, /build:ptc/u, 'the message says how to produce one')
  })
})

await test('--staged is refused on stage, where a target must be named', async () => {
  await withTempDir('scope-stage', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    const result = run(path.join(pkg, 'bin', 'native-runtime.mjs'), ['stage', '--staged', '--root', pkg])
    assert.notEqual(result.status, 0, 'stage --staged is meaningless and must fail')
    assert.match(result.out, /--staged only applies to check/u)
  })
})

await test('an unsupported target is refused by name in both commands', async () => {
  await withTempDir('scope-foreign', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    for (const command of ['check', 'stage']) {
      const result = run(path.join(pkg, 'bin', 'native-runtime.mjs'), [command, '--platform', 'darwin-arm64', '--root', pkg])
      assert.notEqual(result.status, 0, `${command} --platform darwin-arm64 must fail`)
      assert.match(result.out, /Unsupported target/u)
    }
  })
})

await test('check-release closes a single-platform build and says what it skipped', async () => {
  await withTempDir('scope-release', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    const result = run(CHECK_RELEASE, ['--root', pkg])
    assert.equal(result.status, 0, `the closure rejected a valid Linux-only package:\n${result.out}`)
    assert.match(result.out, /Release closure OK: dsh-ops@/u)
    assert.match(result.out, /Bash IPC closure skipped/u, 'the skipped Windows closure is stated, never implied')
  })
})

await test('DSH_OPS_REQUIRE_ALL_TARGETS=1 turns a missing platform into a failure', async () => {
  await withTempDir('scope-all', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    const result = run(CHECK_RELEASE, ['--root', pkg], { DSH_OPS_REQUIRE_ALL_TARGETS: '1' })
    assert.notEqual(result.status, 0, 'a release claiming two platforms must carry both')
    assert.match(result.out, /missing win32-x64/u, 'the missing target is named')
  })
})

await test('a declared scope that disagrees with the resolver PLATFORMS is refused', async () => {
  await withTempDir('scope-drift', (dir) => {
    const pkg = makePackage(dir, { os: ['win32'], staged: ['win32-x64'] })
    const result = run(CHECK_RELEASE, ['--root', pkg])
    assert.notEqual(result.status, 0, 'package.json and PLATFORMS must not disagree')
    assert.match(result.out, /disagree/u, 'the drift is reported as such')
    assert.match(result.out, /linux-x64/u, 'both sides of the disagreement are shown')
  })
})

await test('a declared target that the resolver does not support is refused', async () => {
  await withTempDir('scope-unsupported', (dir) => {
    const pkg = makePackage(dir, { os: ['win32', 'linux', 'darwin'], staged: ['linux-x64'] })
    const result = run(CHECK_RELEASE, ['--root', pkg])
    assert.notEqual(result.status, 0, 'a package must not declare a target the resolver cannot run')
    assert.match(result.out, /unsupported target/u)
    assert.match(result.out, /darwin-x64/u)
  })
})

await test('an undeclared directory under runtime/ is refused rather than ignored', async () => {
  await withTempDir('scope-stray', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'] })
    fs.mkdirSync(path.join(pkg, 'runtime', 'darwin-arm64'), { recursive: true })
    const result = run(CHECK_RELEASE, ['--root', pkg])
    assert.notEqual(result.status, 0, 'a stray runtime target must not ship unnoticed')
    assert.match(result.out, /Unexpected runtime targets/u)
    assert.match(result.out, /darwin-arm64/u)
  })
})

await test('a tampered worker is caught by the closure, not just by a bare check', async () => {
  await withTempDir('scope-tamper', (dir) => {
    const pkg = makePackage(dir, { staged: ['linux-x64'], tamper: { target: 'linux-x64' } })
    const result = run(CHECK_RELEASE, ['--root', pkg])
    assert.notEqual(result.status, 0, 'a modified worker must fail the closure')
    assert.match(result.out, /provenance mismatch|Native runtime gate failed/u)
  })
})

await test('the npm script name and the scope the closure uses cannot drift apart again', async () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).scripts
  assert.match(scripts['check:ptc-runtime'], /check --staged/u,
    'check:ptc-runtime must validate the staged set, or it fails on any one-host build')
  assert.equal(scripts['verify:release'], 'npm run verify && node bin/check-release.mjs')
  assert.doesNotMatch(fs.readFileSync(CHECK_RELEASE, 'utf8'), /Release scope must be Windows x64/u,
    'the hard-coded Windows-only scope assertion must not come back')
})

report('release-scope')
