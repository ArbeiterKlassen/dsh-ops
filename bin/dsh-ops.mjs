#!/usr/bin/env node
/**
 * `dsh-ops` — operator commands for the dsh-ops plugin.
 *
 * The plugin resolves its native worker and shells automatically, so these
 * commands are not required for a normal install. They exist for what automatic
 * resolution cannot do: install into a DSH profile, build the native worker from
 * source, turn the pinned upstream shell releases into local copies, clean up
 * files older versions left outside the profile, and report what this
 * deployment resolves and which rungs the prompt ladder renders.
 *
 * @module dsh-ops/cli
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PACKAGE_ROOT, dshHome } from '../lib/paths.js'
import { profileCommand } from '../lib/profile-install.js'
import { resolveConfig } from '../lib/config.js'
import {
  BASH_TOOL,
  FILE_TOOLS,
  ladderLevels,
  publicToolName,
  renderToolingPolicy,
} from '../lib/policy.js'
import { cargoBuild, findCargo } from '../lib/rust.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { restrictedCompatibility } from '../lib/bash-ipc.js'
import {
  PLATFORM_PACKAGES,
  SHELL_UPSTREAM_PINS,
  provisionedShellStore,
  provisionedShellVersionDir,
  resolveShells,
  shellExecutable,
} from '../lib/shells.js'

/**
 * The unit `uninstall` removes: `<DSH_HOME>/dsh-ops`, holding what older
 * versions installed outside the profile (the former FastCtx runtime under
 * `bin/` with its `runtime.json`) and the shells `provision-shells` installed.
 * @returns {string} the absolute directory.
 */
function managedDir() {
  return path.join(dshHome(), 'dsh-ops')
}

/**
 * The per-user state directory the removed FastCtx background backend used.
 *
 * FastCtx resolved this from the environment the host process received —
 * `~/.fastctx`, holding `config.toml` and the background-job registry under
 * `jobs/`. This version never creates or reads it; `uninstall` only reports it,
 * and removes it when the operator asks (`--purge-fastctx`), so leftovers from
 * an older version can be cleaned up. Another FastCtx install may still own it.
 * @returns {string} the absolute directory.
 */
function fastctxDataDir() {
  return path.join(os.homedir(), '.fastctx')
}

/**
 * Print one usage block.
 * @returns {void}
 */
function usage() {
  console.log(`dsh-ops — operator commands for the dsh-ops plugin

Usage:
  dsh-ops install --profile <desktop|web|tui> [--dsh-cli <path>]
                                  Install this version using the official target-profile manager
  dsh-ops uninstall --profile <desktop|web|tui> [--dsh-cli <path>]
                                  Remove the profile plugin and its binary dependency references
  dsh-ops status --profile <desktop|web|tui>
                                  Report target-profile installation (tui maps to dsh-tui)
  dsh-ops build-ptc              Build the independent native Rust worker (all platforms)
  dsh-ops uninstall [--yes] [--purge-fastctx]
                                  Report files older versions left under <DSH_HOME>/dsh-ops and,
                                  with --yes, remove them; --purge-fastctx also removes leftover
                                  ~/.fastctx state from the removed background component
  dsh-ops ladder [--json] [--config <file>]
                                  Report the native worker, both shells, and the rungs the
                                  prompt ladder actually renders; nothing is spawned
  dsh-ops provision-shells [--bash] [--pwsh] [--force] [--dry-run] [--pin <file>]
                                  Download the pinned upstream bash and/or PowerShell 7, verify
                                  their digests, and install them under <DSH_HOME>/dsh-ops/shells
  dsh-ops help                    This text

Environment:
  DSH_OPS_WORKER_BIN   Explicit native worker executable
  DSH_OPS_CARGO        Explicit cargo executable
  CARGO_HOME           Rust toolchain home (.cargo)
  DSH_OPS_RUST_HOME    Directory containing a relocated .cargo toolchain
  DSH_HOME             DSH home; the provisioned shells live in <DSH_HOME>/dsh-ops/shells
  HTTPS_PROXY          Proxy handed to curl explicitly by provision-shells

With --profile, install/uninstall delegate to the official DSH profile manager.
Without --profile, uninstall only cleans legacy provisioned runtime/shell files;
use --yes to confirm that separate cleanup. No system shell or shared npm cache is removed.
`)
}

/**
 * Commands removed together with the FastCtx background backend, and what replaces each.
 * They fail with that answer instead of the generic unknown-command text, so an old script
 * or habit gets told where to go.
 */
const REMOVED_COMMANDS = Object.freeze({
  resolve: 'use `dsh-ops ladder` to see what this deployment resolves',
  status: 'use `dsh-ops ladder` for this deployment, or `dsh-ops status --profile <desktop|web|tui>` for a profile install',
  build: 'use `dsh-ops build-ptc` to build the native worker',
  provision: 'the native worker ships in the package (or `dsh-ops build-ptc` from a checkout); use `dsh-ops provision-shells` for the shells',
})

/**
 * Read the `dsh-ops` row config a report should describe.
 *
 * The commands here are run outside a profile, so there is no loader to ask:
 * `--config` names a JSON file holding the row's own `config` object, and the
 * keys are the ones the row accepts. Passing it through `resolveConfig` is what
 * keeps this report and the plugin's mount answering the same question — an
 * unknown key fails here exactly as it would fail activation.
 * @param {string|undefined} file - the `--config` path, when one was given.
 * @returns {unknown} the raw row config.
 * @throws {Error} when the file cannot be read, does not parse, or is not an object.
 */
function readRowConfig(file) {
  if (file === undefined) return {}
  const resolved = path.resolve(file)
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new Error(`--config does not name a readable file: ${resolved} (${error.message})`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`--config must hold one JSON object (the \`dsh-ops\` row's config): ${error.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`--config must hold one JSON object (the \`dsh-ops\` row's config), got ${typeof value}`)
  }
  return value
}

/**
 * The native worker resolution as a report value — the same `resolveWorker` the
 * file component runs at mount, including the packaged runtime's provenance
 * check. Nothing is spawned; the resolver's own error text explains a miss.
 * @param {import('../lib/config.js').ResolvedConfig} config - the plugin configuration.
 * @returns {{resolved: boolean, executable: string|null, source: string|null, error: string|null}} the report value.
 */
function workerReport(config) {
  try {
    const file = resolveWorker(config)
    const source = config.binaryPath !== undefined ? 'config.binaryPath'
      : process.env.DSH_OPS_WORKER_BIN !== undefined ? 'DSH_OPS_WORKER_BIN'
        : path.relative(PACKAGE_ROOT, file).split(path.sep)[0] === 'runtime' ? 'packaged runtime' : 'source-tree build'
    return { resolved: true, executable: file, source, error: null }
  } catch (error) {
    return { resolved: false, executable: null, source: null, error: String(error?.message ?? error) }
  }
}

/**
 * One shell rung as a report value: `executable` is null exactly when the rung
 * is unavailable, and `detail` is the resolver's own reason either way.
 * @param {import('../lib/shells.js').ShellResolution} resolution - the rung's resolution.
 * @returns {{available: boolean, executable: string|null, source: string, detail: string}} the report value.
 */
function shellReport(resolution) {
  return {
    available: resolution.available === true,
    executable: resolution.file ?? null,
    source: resolution.source,
    detail: resolution.detail,
  }
}

/**
 * Whether read-only / workspace-write sessions can run the resolved bash: they
 * accept only the pinned MSYS the IPC proxies were verified against (#42).
 * @param {import('../lib/shells.js').ShellResolution} resolution - the bash rung.
 * @returns {{compatible: boolean, reason: string}|null} null when there is no bash to check.
 */
function restrictedReport(resolution) {
  if (resolution.available !== true || typeof resolution.file !== 'string') return null
  try {
    const { compatible, reason } = restrictedCompatibility(resolution.file)
    return { compatible, reason }
  } catch (error) {
    return { compatible: false, reason: String(error?.message ?? error) }
  }
}

/**
 * The rungs this deployment can reach, from the same derivation the plugin's
 * prompt uses.
 *
 * The plugin asks the live registry; this command has no registry, so it
 * answers from resolution instead: a resolved native worker stands in for the
 * published file tools, and a resolved bash stands in for the published
 * `ops_bash` tool (which also needs the host's `subprocess` service).
 * `ladderLevels` still decides, so the rungs and their numbering come from the
 * renderer that ships them rather than from a second copy here.
 * @param {object} options - the ladder input.
 * @param {{resolved: boolean}} options.worker - the native worker report value.
 * @param {{bash: {available: boolean}, pwsh: {available: boolean}}} options.shells - the shell resolutions.
 * @param {import('../lib/config.js').ResolvedConfig} options.config - the plugin configuration.
 * @returns {import('../lib/policy.js').LadderLevels} the rungs.
 */
function ladderFor({ worker, shells, config }) {
  const published = worker.resolved ? FILE_TOOLS.map(publicToolName) : []
  if (config.publishBashTool && shells.bash.available) published.push(BASH_TOOL)
  if (shells.pwsh.available) published.push('pwsh')
  return ladderLevels({ published, pwsh: shells.pwsh.available })
}

/**
 * The `## Rung …` headings of a rendered ladder, as numbered titles.
 * @param {string} text - the rendered tooling section.
 * @returns {{number: number, title: string}[]} one entry per rendered rung, in render order.
 */
function renderedRungs(text) {
  const rungs = []
  for (const line of text.split('\n')) {
    const match = /^## Rung (\d+) — (.*)$/u.exec(line)
    if (match !== null) rungs.push({ number: Number(match[1]), title: match[2] })
  }
  return rungs
}

/**
 * Print one ladder report for a human.
 * @param {object} report - the report value `commandLadder` assembled.
 * @returns {void}
 */
function printLadder(report) {
  console.log('Native worker (file tools)')
  if (report.worker.resolved) {
    console.log(`  executable: ${report.worker.executable}`)
    console.log(`  source:     ${report.worker.source}`)
  } else {
    console.log('  executable: missing')
    for (const line of report.worker.error.split('\n')) console.log(`  ${line}`)
  }

  console.log('\nShell rungs (lib/shells.js resolveShells)')
  for (const kind of ['bash', 'pwsh']) {
    const rung = report.shells[kind]
    console.log(`  ${kind}`)
    console.log(`    available:  ${rung.available ? 'yes' : 'no'}`)
    console.log(`    executable: ${rung.executable ?? 'missing'}`)
    console.log(`    source:     ${rung.source}`)
    console.log(`    detail:     ${rung.detail}`)
    if (rung.restricted) {
      console.log(`    restricted: ${rung.restricted.compatible ? 'yes' : 'no'} (${rung.restricted.reason})`)
    }
  }

  console.log('\nThree layers: repository tools → bash → PowerShell 7')
  console.log(report.policy || '(no file tools resolved)')
  console.log('\nResolution only: command visibility requires a live host session and sandboxPolicy.')
  console.log('Resolved candidates only; bash also needs the host subprocess service. Full access runs the executable directly;')
  console.log('read-only / workspace-write additionally require the pinned MSYS (see "restricted"), so a custom bashPath works only in full access. Nothing is spawned.')
}

/**
 * `ladder`: report what this deployment resolves and which rungs the model is
 * actually told it can reach — the three questions a missing bundled shell
 * would otherwise need a fresh session to answer.
 *
 * Nothing is spawned. Missing rungs are the report,
 * not a failure, so the exit code is 0 whenever a report was produced and 1 only
 * for a config this command cannot honour.
 * @param {object} options - ladder inputs.
 * @param {boolean} options.json - print the machine-readable report instead of the human one.
 * @param {string|undefined} options.configFile - the `--config` path, when one was given.
 * @returns {number} the exit code.
 */
function commandLadder({ json, configFile }) {
  let config
  try {
    config = resolveConfig(readRowConfig(configFile))
  } catch (error) {
    console.error(error.message)
    return 1
  }

  const worker = workerReport(config)
  const shells = resolveShells(config)
  const levels = ladderFor({ worker, shells, config })
  const report = {
    worker,
    shells: { bash: { ...shellReport(shells.bash), restricted: restrictedReport(shells.bash) }, pwsh: shellReport(shells.pwsh) },
    levels,
    rungs: [],
    policy: renderToolingPolicy({
      published: [
        ...(worker.resolved ? FILE_TOOLS.map(publicToolName) : []),
        ...(levels.bash ? [BASH_TOOL] : []),
        ...(levels.pwsh ? ['pwsh'] : []),
      ],
      extraGuidance: config.extraGuidance,
    }),
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }
  printLadder(report)
  return 0
}

// ---------------------------------------------------------------------------
// provision-shells: the pinned upstream shells become local copies
// ---------------------------------------------------------------------------

/** Receipt schema written inside one provisioned shell's version directory. */
const SHELL_RECEIPT_VERSION = 1

/** The marker file a provisioned version directory carries. */
const SHELL_RECEIPT_FILE = '.provisioned.json'

/** The archive shapes a pin may name, and how each is opened. */
const PIN_EXTRACTORS = Object.freeze(['zip', 'sfx-7z', 'tar.gz'])

/** The fields every pin must carry; `executableSha256` and the labels are optional. */
const PIN_REQUIRED_FIELDS = Object.freeze([
  'name',
  'platform',
  'arch',
  'version',
  'assetFile',
  'url',
  'sha256',
  'bytes',
  'extractor',
  'extractTo',
  'executableRelativePath',
])

/**
 * The SHA-256 of one file, streamed so a 100 MB archive is never held in memory
 * twice.
 * @param {string} file - the file to hash.
 * @returns {string} the lowercase hex digest.
 */
function sha256File(file) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  const handle = fs.openSync(file, 'r')
  try {
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

/**
 * The last few non-empty lines of one stream, for a failure report.
 * @param {string|undefined} text - the stream.
 * @param {number} [count] - how many lines to keep.
 * @returns {string[]} the lines.
 */
function tailLines(text, count = 8) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-count)
}

/**
 * Run one helper program, and report the tail of its stderr when it fails.
 * @param {string} file - the program.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - run inputs.
 * @param {string} [options.cwd] - working directory for the child.
 * @returns {{ok: true}|{error: string, stderr: string[]}} the outcome.
 */
function runTool(file, args, { cwd } = {}) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined && result.error !== null) {
    return { error: `could not run ${file}: ${String(result.error.message ?? result.error)}`, stderr: [] }
  }
  if (result.status !== 0) {
    return { error: `${file} exited with code ${result.status}`, stderr: tailLines(result.stderr) }
  }
  return { ok: true }
}

/**
 * The proxy one environment names, in curl's own precedence.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @returns {string|undefined} the proxy URL, when one is named.
 */
function proxyFor(env) {
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Download one pinned asset with the platform's own `curl`.
 *
 * The child inherits this process's environment — curl reads the proxy
 * variables itself — and a named proxy is ALSO passed as `--proxy`, so the
 * answer does not depend on which of curl's own variables wins. `process.env` is
 * read, never written.
 * @param {object} options - download inputs.
 * @param {{url: string, assetFile: string}} options.pin - what to fetch.
 * @param {string} options.into - the directory to write the asset into.
 * @param {NodeJS.ProcessEnv} options.env - the environment to read.
 * @returns {{file: string}|{error: string, detail: string, stderr: string[]}} the asset, or why not.
 */
function curlAsset({ pin, into, env }) {
  const file = path.join(into, pin.assetFile)
  const proxy = proxyFor(env)
  const args = ['--location', '--fail', '--silent', '--show-error', '--output', file]
  if (proxy !== undefined) args.push('--proxy', proxy)
  args.push(pin.url)
  const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8',
    windowsHide: true,
    env,
  })
  if (result.error !== undefined && result.error !== null) {
    return {
      error: `could not run curl: ${String(result.error.message ?? result.error)}`,
      detail: 'Windows 10 and newer ship curl.exe; install curl on this machine, or provision where one exists',
      stderr: [],
    }
  }
  if (result.status !== 0) {
    return {
      error: `curl exited with code ${result.status}`,
      detail: `could not download ${pin.url}`
        + (proxy === undefined ? '' : ` through the proxy ${proxy}`)
        + ' — check the network, the proxy configuration, and whether the upstream release still carries that asset',
      stderr: tailLines(result.stderr),
    }
  }
  return { file }
}

/**
 * A `tar` that can open a zip: Windows' own bsdtar, never the GNU tar a Git
 * installation puts on PATH.
 *
 * The distinction is not cosmetic. GNU tar cannot read a zip container, so
 * pointing it at the PowerShell archive fails with a message about a corrupt
 * archive rather than about the wrong program. `%SystemRoot%\System32\tar.exe`
 * is the bsdtar Windows 10 and newer ship, and its `--version` says so.
 * @param {NodeJS.ProcessEnv} env - the environment to locate it with.
 * @returns {string|undefined} the program, or undefined when there is none.
 */
function findZipCapableTar(env) {
  const candidates = process.platform === 'win32'
    ? [path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')]
    : []
  candidates.push('tar')
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0 && /bsdtar|libarchive/u.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Unpack one verified asset into a version directory.
 * @param {object} options - unpack inputs.
 * @param {{extractor: string, extractTo: string}} options.pin - the pin.
 * @param {string} options.asset - the verified archive.
 * @param {string} options.target - the version directory.
 * @returns {{ok: true}|{error: string, stderr: string[]}} the outcome.
 */
function unpackAsset({ pin, asset, target }) {
  const into = path.resolve(target, pin.extractTo)
  if (pin.extractor === 'zip') {
    const tar = findZipCapableTar(process.env)
    if (tar === undefined) {
      return {
        error: 'no zip-capable tar found',
        stderr: [
          'reading a zip needs a libarchive-based tar: on Windows that is the bsdtar shipped at '
          + '%SystemRoot%\\System32\\tar.exe, because the tar a Git installation puts on PATH is GNU tar, '
          + 'which cannot read a zip. Prefer a `tar.gz` pin on platforms that have one.',
        ],
      }
    }
    return runTool(tar, ['-xf', asset, '-C', into])
  }
  if (pin.extractor === 'sfx-7z') {
    // PortableGit's archive IS a 7-Zip self-extractor: `-o<dir>` names where it
    // unpacks and `-y` answers its own prompts.
    return runTool(asset, [`-o${into}`, '-y'], { cwd: path.dirname(asset) })
  }
  if (pin.extractor === 'tar.gz') {
    // What every POSIX upstream publishes. `tar` here is libarchive's bsdtar on
    // macOS and GNU tar on Linux; both read a gzipped tar, and both keep the
    // mode bits that make the payload spawnable.
    return runTool('tar', ['-xzf', asset, '-C', into])
  }
  return { error: `unknown extractor ${JSON.stringify(pin.extractor)}`, stderr: [] }
}

/**
 * Validate one pin object from a `--pin` file.
 *
 * The fields become path segments (`name`, `version`), a file name
 * (`assetFile`), and an extraction directory (`extractTo`), so they are checked
 * rather than trusted: this table is the one operator-supplied input that
 * reaches the filesystem and the network.
 * @param {unknown} value - the candidate pin.
 * @param {number} index - its position, for the error message.
 * @returns {object} the validated pin.
 * @throws {Error} when a field is missing or malformed.
 */
function validatePin(value, index) {
  const at = `pins[${index}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at} must be an object`)
  }
  const pin = /** @type {Record<string, unknown>} */ (value)
  for (const field of PIN_REQUIRED_FIELDS) {
    if (pin[field] === undefined) throw new Error(`${at}.${field} is required`)
  }

  /**
   * One field as a non-empty string.
   * @param {string} key - the field.
   * @returns {string} its value.
   */
  const text = (key) => {
    const entry = pin[key]
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${at}.${key} must be a non-empty string, got ${JSON.stringify(entry)}`)
    }
    return entry
  }

  /**
   * One field as a value safe to use as a single path segment.
   * @param {string} key - the field.
   * @returns {string} its value.
   */
  const segment = (key) => {
    const entry = text(key)
    if (entry.includes('/') || entry.includes('\\') || entry.includes('..') || path.isAbsolute(entry)) {
      throw new Error(`${at}.${key} must be a plain name, got ${JSON.stringify(entry)}`)
    }
    return entry
  }

  /**
   * One field as a relative path that stays inside the version directory.
   * @param {string} key - the field.
   * @returns {string} its value.
   */
  const relative = (key) => {
    const entry = text(key)
    if (path.isAbsolute(entry) || entry.split(/[\\/]/u).includes('..')) {
      throw new Error(`${at}.${key} must be a relative path inside the version directory, got ${JSON.stringify(entry)}`)
    }
    return entry
  }

  const name = text('name')
  if (!Object.hasOwn(PLATFORM_PACKAGES, name)) {
    throw new Error(`${at}.name must be one of ${Object.keys(PLATFORM_PACKAGES).join(', ')}, got ${JSON.stringify(name)}`)
  }
  if (!PIN_EXTRACTORS.includes(text('extractor'))) {
    throw new Error(`${at}.extractor must be one of ${PIN_EXTRACTORS.join(', ')}, got ${JSON.stringify(pin.extractor)}`)
  }
  if (!/^[0-9a-f]{64}$/u.test(text('sha256'))) {
    throw new Error(`${at}.sha256 must be 64 lowercase hex characters, got ${JSON.stringify(pin.sha256)}`)
  }
  if (!Number.isSafeInteger(pin.bytes) || /** @type {number} */ (pin.bytes) <= 0) {
    throw new Error(`${at}.bytes must be a positive whole number, got ${JSON.stringify(pin.bytes)}`)
  }
  const executableRelativePath = relative('executableRelativePath')
  // The expected file name follows the pin's own platform, not the host's: a pin
  // table is validated on whatever machine runs the provisioner, and a `darwin`
  // pin's payload has no `.exe`.
  const expectedExecutable = shellExecutable(name, text('platform'))
  if (path.basename(executableRelativePath) !== expectedExecutable) {
    throw new Error(`${at}.executableRelativePath must end in ${expectedExecutable}, `
      + `got ${JSON.stringify(executableRelativePath)}`)
  }
  if (pin.executableSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(String(pin.executableSha256))) {
    throw new Error(`${at}.executableSha256 must be 64 lowercase hex characters, got ${JSON.stringify(pin.executableSha256)}`)
  }

  return {
    ...pin,
    name,
    version: segment('version'),
    platform: text('platform'),
    arch: text('arch'),
    assetFile: segment('assetFile'),
    url: text('url'),
    extractor: text('extractor'),
    extractTo: relative('extractTo'),
    executableRelativePath,
  }
}

/**
 * The pins `provision-shells` works from.
 *
 * The shipped table is the default; `--pin` replaces it with one JSON file — a
 * mirror, an offline pin set, or a test fixture. Every pin that arrives that way
 * is validated, because these values become paths and a download.
 * @param {string|undefined} file - the `--pin` path, when one was given.
 * @returns {object[]} the pins.
 * @throws {Error} when the file is unreadable or a pin is malformed.
 */
function pinTable(file) {
  if (file === undefined) return SHELL_UPSTREAM_PINS.map((pin, index) => validatePin(pin, index))
  const resolved = path.resolve(file)
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new Error(`--pin does not name a readable file: ${resolved} (${error.message})`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`--pin must hold one JSON document of pins: ${error.message}`)
  }
  const list = Array.isArray(value) ? value : value?.pins
  if (!Array.isArray(list)) {
    throw new Error('--pin must hold one JSON array of pins (or an object with a "pins" array)')
  }
  return list.map((pin, index) => validatePin(pin, index))
}

/**
 * Read one provision marker, or undefined when it is absent or unreadable.
 * @param {string} file - the marker file.
 * @returns {object|undefined} the parsed marker.
 */
function readShellReceipt(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Provision one pinned shell: download, verify, unpack, and record.
 *
 * Nothing outside the deployment is written: the asset lands in a fresh
 * temporary directory that is removed once the copy is in place, and the copy
 * lands in `<DSH_HOME>/dsh-ops/shells/<name>/<version>`. A failure keeps the
 * downloaded bytes and says where they are, because "the digest did not match"
 * is only actionable with the file in hand.
 * @param {object} pin - the validated pin.
 * @param {object} options - run inputs.
 * @param {boolean} options.force - reinstall even when a matching copy is present.
 * @param {boolean} options.dryRun - report what would happen, and download nothing.
 * @returns {boolean} whether this shell is provisioned (or already was).
 */
function provisionShell(pin, { force, dryRun }) {
  const target = provisionedShellVersionDir({ kind: pin.name, version: pin.version })
  const executable = path.join(target, pin.executableRelativePath)
  const receiptFile = path.join(target, SHELL_RECEIPT_FILE)
  const receipt = readShellReceipt(receiptFile)
  if (!force && receipt?.sha256 === pin.sha256 && fs.existsSync(executable)) {
    console.log(`${pin.name}: already provisioned — ${executable}`)
    console.log(`  version:    ${pin.version}`)
    console.log(`  sha256:     ${pin.sha256}`)
    return true
  }

  if (dryRun) {
    console.log(`${pin.name}: would provision version ${pin.version} (dry run: no download, no writes)`)
    console.log(`  url:        ${pin.url}`)
    console.log(`  asset:      ${pin.assetFile} (${formatBytes(pin.bytes)})`)
    console.log(`  sha256:     ${pin.sha256}`)
    console.log(`  unpack:     ${pin.extractor} into ${path.resolve(target, pin.extractTo)}`)
    console.log(`  target:     ${target}`)
    console.log(`  executable: ${executable}`)
    return true
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ops-${pin.name}-`))
  console.log(`${pin.name}: downloading ${pin.url}`)
  const downloaded = curlAsset({ pin, into: scratch, env: process.env })
  if (!('file' in downloaded)) {
    console.error(`${pin.name}: ${downloaded.error} — ${downloaded.detail}`)
    for (const line of downloaded.stderr) console.error(`  curl: ${line}`)
    console.error(`  kept for diagnosis: ${scratch}`)
    return false
  }

  const actual = sha256File(downloaded.file)
  if (actual !== pin.sha256) {
    console.error(`${pin.name}: ${pin.assetFile} hashed to ${actual}, not the pinned ${pin.sha256}`)
    console.error('  refusing to install bytes this distribution did not pin')
    console.error(`  kept for diagnosis: ${downloaded.file}`)
    return false
  }
  console.log(`${pin.name}: verified sha256 ${actual}`)

  if (force) fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.resolve(target, pin.extractTo), { recursive: true })
  const unpacked = unpackAsset({ pin, asset: downloaded.file, target })
  if (!('ok' in unpacked)) {
    console.error(`${pin.name}: ${unpacked.error}`)
    for (const line of unpacked.stderr) console.error(`  ${line}`)
    console.error(`  kept for diagnosis: ${downloaded.file}`)
    return false
  }

  if (!fs.existsSync(executable)) {
    console.error(`${pin.name}: the archive unpacked without ${pin.executableRelativePath}`)
    console.error(`  expected it at ${executable}`)
    console.error(`  kept for diagnosis: ${downloaded.file}`)
    return false
  }
  if (pin.executableSha256 !== undefined) {
    const executableActual = sha256File(executable)
    if (executableActual !== pin.executableSha256) {
      console.error(`${pin.name}: the provisioned ${pin.executableRelativePath} hashed to ${executableActual}, `
        + `not the pinned ${pin.executableSha256}`)
      console.error(`  kept for diagnosis: ${downloaded.file}`)
      return false
    }
  }

  fs.writeFileSync(receiptFile, `${JSON.stringify({
    schemaVersion: SHELL_RECEIPT_VERSION,
    name: pin.name,
    version: pin.version,
    releaseTag: pin.releaseTag ?? null,
    upstreamRepo: pin.upstreamRepo ?? null,
    url: pin.url,
    assetFile: pin.assetFile,
    bytes: pin.bytes,
    sha256: pin.sha256,
    extractor: pin.extractor,
    extractTo: pin.extractTo,
    executable: pin.executableRelativePath,
    executableSha256: pin.executableSha256 ?? null,
    provisionedBy: 'dsh-ops provision-shells',
    provisionedAt: new Date().toISOString(),
    dshHome: dshHome(),
  }, null, 2)}\n`)
  fs.rmSync(scratch, { recursive: true, force: true })

  // The store holds the version the pins name. A previous version is a copy this
  // distribution no longer vouches for — and one the resolution would still
  // consider, because it takes the greatest version name — so it is removed
  // here, after a successful install and never before it.
  const store = path.join(provisionedShellStore({ env: process.env }), pin.name)
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === pin.version) continue
    const stale = path.join(store, entry.name)
    try {
      fs.rmSync(stale, { recursive: true, force: true })
      console.log(`  removed:    ${stale} (a version this pin no longer names)`)
    } catch (error) {
      console.error(`  warning:    could not remove the previous version ${stale}: ${error.message}`)
    }
  }

  console.log(`${pin.name}: provisioned ${executable}`)
  console.log(`  receipt:    ${receiptFile}`)
  return true
}

/**
 * `provision-shells`: turn the pinned upstream releases into the local copies
 * the shell rungs prefer.
 *
 * The pointer is the whole distribution story for these two binaries: this
 * command is what reads {@link SHELL_UPSTREAM_PINS}, downloads the exact
 * archive, checks the exact digest, and unpacks it under `DSH_HOME`. A shell
 * that is already there with the pinned digest is left alone (`--force` is the
 * way to reinstall), and `--dry-run` answers "what would this do" without
 * touching the network or the filesystem.
 * @param {object} options - command inputs.
 * @param {('bash'|'pwsh')[]} options.kinds - which shells to provision.
 * @param {boolean} options.force - reinstall even when current.
 * @param {boolean} options.dryRun - report only.
 * @param {string|undefined} options.pinFile - read the pins from this JSON file instead.
 * @returns {number} the exit code: 0 when every selected shell is in place, 1 otherwise.
 */
function commandProvisionShells({ kinds, force, dryRun, pinFile }) {
  // The pinned payload is the Windows one: a Windows host carries no POSIX shell, so this
  // distribution provisions and digest-checks one there. A POSIX host already has its
  // distribution's own bash, so there is nothing to install — say that instead of failing on an
  // empty pin table (report: the shell component's POSIX rung).
  if (process.platform !== 'win32') {
    console.error(`dsh-ops provisions shells on Windows only; this host (${process.platform}-${process.arch}) already has its own bash,`
      + " and the shell component resolves it (PATH, then /bin/bash, /usr/bin/bash, /usr/local/bin/bash). Use config.bashPath to pin an explicit executable instead.")
    return 1
  }
  let pins
  try {
    pins = pinTable(pinFile)
  } catch (error) {
    console.error(error.message)
    return 1
  }

  const selected = []
  for (const kind of kinds) {
    const pin = pins.find((candidate) => (
      candidate.name === kind && candidate.platform === process.platform && candidate.arch === process.arch
    ))
    if (pin === undefined) {
      const covered = [...new Set(pins.map((candidate) => `${candidate.platform}-${candidate.arch}`))].join(', ')
      console.error(`no upstream pin for ${kind} on ${process.platform}-${process.arch}`
        + (covered === '' ? '' : `; the pin table covers ${covered}`)
        + (kind === 'bash'
          ? '. No upstream project publishes a portable bash for every platform: on macOS and Linux '
            + 'point the shell component at the copy the machine already has with `bashPath` '
            + '(for example /opt/homebrew/bin/bash).'
          : '.'))
      return 1
    }
    selected.push(pin)
  }

  let failed = 0
  for (const pin of selected) {
    if (!provisionShell(pin, { force, dryRun })) failed += 1
  }
  return failed === 0 ? 0 : 1
}

/**
 * Render a byte count for a human report.
 * @param {number} bytes - the size.
 * @returns {string} the size in the largest unit that keeps it readable.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Measure a file or directory without following symbolic links out of the tree:
 * an unreadable entry reports zero rather than failing the report.
 * @param {string} entry - the path to measure.
 * @returns {number} the byte count.
 */
function measure(entry) {
  let stat
  try {
    stat = fs.lstatSync(entry)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
    total += measure(path.join(entry, child.name))
  }
  return total
}

/**
 * Describe the top-level entries of a directory, for reporting what a removal
 * would take with it.
 * @param {string} dir - the directory.
 * @returns {{name: string, bytes: number}[]} one row per entry, directories first.
 */
function contentsOf(dir) {
  const rows = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.isDirectory() ? `${entry.name}${path.sep}` : entry.name,
    bytes: measure(path.join(dir, entry.name)),
  }))
  return rows.sort((left, right) => {
    const leftDir = left.name.endsWith(path.sep)
    const rightDir = right.name.endsWith(path.sep)
    return leftDir === rightDir ? left.name.localeCompare(right.name) : leftDir ? -1 : 1
  })
}

/**
 * Report one directory and its contents under a section heading.
 * @param {string} label - the section heading.
 * @param {string} dir - the directory to describe.
 * @returns {{missing: boolean, rows: {name: string, bytes: number}[], bytes: number}} the report.
 */
function reportDirectory(label, dir) {
  console.log(`\n${label}`)
  console.log(`  directory: ${dir}`)
  if (!fs.existsSync(dir)) {
    console.log('  contents:  (does not exist)')
    return { missing: true, rows: [], bytes: 0 }
  }
  const rows = contentsOf(dir)
  const bytes = rows.reduce((total, row) => total + row.bytes, 0)
  console.log(rows.length === 0
    ? '  contents:  (empty)'
    : `  contents:  ${rows.map((row) => `${row.name} (${formatBytes(row.bytes)})`).join(', ')}`)
  console.log(`  total:     ${formatBytes(bytes)}`)
  return { missing: false, rows, bytes }
}

/**
 * `uninstall`: remove what this plugin (and older versions of it) installed
 * outside the profile, and report the state it does not own.
 *
 * Removing the plugin itself is a profile operation — `dsh plugin --profile
 * <profile> remove dsh-ops`, or the `plugin_manager` `remove_bundle` tool — and
 * stays outside this command. What is inside: `<DSH_HOME>/dsh-ops` (provisioned
 * shells, and the FastCtx runtime older versions provisioned), and, only on
 * request, the leftover `~/.fastctx` state of the removed background component.
 *
 * Nothing is deleted without `--yes`, so a bare invocation is the report.
 *
 * @param {object} options - uninstall inputs.
 * @param {boolean} options.yes - perform the removals instead of reporting them.
 * @param {boolean} options.purgeFastctx - also remove FastCtx's own state directory.
 * @param {boolean} options.dryRun - report only, whatever `yes` says.
 * @returns {number} the exit code: 0 when the requested state is gone or absent, 1 when a removal failed.
 */
function commandUninstall({ yes, purgeFastctx, dryRun }) {
  const removing = yes && !dryRun
  console.log(`dsh-ops uninstall — ${removing ? 'removing' : 'report only (dry run; pass --yes to delete)'}`)

  const managed = managedDir()
  const managedReport = reportDirectory(`managed files (<DSH_HOME>/dsh-ops)`, managed)
  if (managedReport.missing) {
    console.log('  action:    nothing to remove')
  } else if (!removing) {
    console.log(`  action:    would remove this directory and its ${formatBytes(managedReport.bytes)}`)
  } else {
    try {
      fs.rmSync(managed, { recursive: true, force: true })
      console.log('  action:    removed')
    } catch (error) {
      console.error(`  action:    FAILED to remove ${managed}: ${error.message}`)
      return 1
    }
  }

  const fastctx = fastctxDataDir()
  const fastctxReport = reportDirectory("FastCtx user data (not owned by this plugin; left over from the removed background component)", fastctx)
  if (fastctxReport.missing) {
    console.log('  action:    nothing to remove')
  } else if (!purgeFastctx) {
    console.log('  action:    kept (pass --yes --purge-fastctx to remove it as well)')
  } else if (!removing) {
    console.log(`  action:    would remove this directory and its ${formatBytes(fastctxReport.bytes)}`)
  } else {
    try {
      fs.rmSync(fastctx, { recursive: true, force: true })
      console.log('  action:    removed')
    } catch (error) {
      console.error(`  action:    FAILED to remove ${fastctx}: ${error.message}`)
      return 1
    }
  }

  console.log('\nplugin installation (not handled by this command)')
  console.log('  action:    remove the plugin itself with `dsh plugin --profile <profile> remove dsh-ops`,')
  console.log('             or the plugin_manager `remove_bundle` tool; this command only removes the')
  console.log('             runtime and state the plugin wrote outside the profile.')

  return 0
}

/**
 * Parse arguments and run one command.
 * @returns {Promise<number>} the exit code.
 */
async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      'dsh-cli': { type: 'string' },
      force: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'purge-fastctx': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      config: { type: 'string' },
      bash: { type: 'boolean', default: false },
      pwsh: { type: 'boolean', default: false },
      pin: { type: 'string' },
    },
  })
  const command = positionals[0] ?? 'help'
  if (positionals.length > 1) throw new Error('Unexpected positional arguments.')
  if (command === 'install' || (['uninstall', 'status'].includes(command) && values.profile !== undefined)) {
    return profileCommand(command, { profile: values.profile, dshCli: values['dsh-cli'], dryRun: values['dry-run'] === true })
  }
  if (Object.hasOwn(REMOVED_COMMANDS, command)) {
    console.error(`dsh-ops: \`${command}\` was removed together with the FastCtx background component; ${REMOVED_COMMANDS[command]}.`)
    return 2
  }
  switch (command) {
    case 'ladder':
      return commandLadder({ json: values.json === true, configFile: values.config })
    case 'build-ptc': {
      const cargo = findCargo()
      console.log(`toolchain: ${cargo.version}`)
      const result = await cargoBuild({ cargo, sourceDir: path.join(PACKAGE_ROOT, 'native'), onLine: line => console.log(line) })
      if (result.code !== 0) return result.code
      const staged = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/native-runtime.mjs'), 'stage', '--platform', `${process.platform}-${process.arch}`], { stdio: 'inherit', windowsHide: true })
      if (staged.error) throw staged.error
      return staged.status ?? 1
    }
    case 'provision-shells': {
      /** No shell flag means both, so a bare invocation is "make this deployment whole". */
      const kinds = []
      if (values.bash === true || values.pwsh === true) {
        if (values.bash === true) kinds.push('bash')
        if (values.pwsh === true) kinds.push('pwsh')
      } else {
        kinds.push('bash', 'pwsh')
      }
      return commandProvisionShells({
        kinds,
        force: values.force === true,
        dryRun: values['dry-run'] === true,
        pinFile: values.pin,
      })
    }
    case 'uninstall':
      return commandUninstall({
        yes: values.yes === true,
        purgeFastctx: values['purge-fastctx'] === true,
        dryRun: values['dry-run'] === true,
      })
    case 'help':
      usage()
      return 0
    default:
      console.error(`dsh-ops: unknown command ${JSON.stringify(command)}\n`)
      usage()
      return 2
  }
}

try { process.exitCode = await main() }
catch (error) { console.error(`dsh-ops: ${error.message}`); process.exitCode = 1 }
