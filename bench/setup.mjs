#!/usr/bin/env node
/**
 * One-shot preparation of the two benchmark profiles, idempotent.
 *
 * It does, in order: create the baseline and candidate profiles from the shipped
 * `headless` template when they do not exist yet, pin the baseline's PowerShell
 * executable to Windows PowerShell 5.1, install the plugin under test into the
 * candidate profile, then read the composed config tree back and prove the pin landed.
 *
 * Why this is a script instead of four README steps:
 *
 * - **Profile creation is not idempotent.** `--from-default-profile` fails when the
 *   profile already exists, so a README line can only ever say "skip it if it errors".
 * - **The baseline's shell engine is a measured condition nobody checks.** The host
 *   resolves the PowerShell executable as explicit `pwshPath` → PowerShell 7 well-known
 *   location → **a PATH scan** → Windows PowerShell 5.1 last. Windows puts a Store `pwsh`
 *   app-execution alias on the user PATH, so without a pin *both* sides run PowerShell 7
 *   and the "stock Windows" comparison silently measures something else. `meta.json` does
 *   not record the engine and `compare.mjs`'s fairness anchor does not cover it, so this
 *   script pins it and then verifies it out of `--dump-config`.
 * - **The pin belongs to one side only.** It goes into the baseline profile's own patch
 *   layer, never into `bench/llm.patch.yml`: that overlay is shared by both sides, and on
 *   the candidate the plugin re-injects `pwshPath` at runtime — a shared overlay would
 *   leave the archived `dump-config.txt` claiming 5.1 while 7 actually executed.
 *
 * It never touches `$DSH_HOME/cordis.patch.yml` (the home layer, which composes into every
 * profile) and never edits a profile's `cordis.yml`. Patch-layer edits are line-local and
 * comment-preserving; anything the editor cannot merge safely is reported with the exact
 * block to paste by hand instead of being rewritten.
 *
 * @module dsh-ops/bench/setup
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { pipedSpawnBlocker, resolveDshEntry } from './run.mjs'
import { poisonedModulePath } from './lib/env.mjs'

/** The `PSModulePath` verdict lives in `lib/env.mjs` now, because preflight needs it too;
 * re-exported here so the documented `bench/setup` surface keeps answering. */
export { poisonedModulePath, describeModulePath } from './lib/env.mjs'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(BENCH_DIR, '..')
/** The patch entry the host's PowerShell executor reads: `dsh-pwsh-sandbox` inherits
 * `dsh-pwsh-local`'s config schema, whose only executable key is `pwshPath`. */
const SHELL_ENTRY_ID = 'pwsh-sandbox'
const SHELL_CONFIG_KEY = 'pwshPath'
/** Shipped template names, kept in step with `SHIPPED_PROFILES` in `run.mjs`. */
const SHIPPED_PROFILES = ['headless', 'web', 'tui', 'acp', 'sdk', 'sdk-minimal', 'dsh-tui']

const USAGE = `usage: node bench/setup.mjs [options]

  --base-profile <name>   stock baseline profile (default bench-base)
  --cand-profile <name>   profile under test (default bench-ops)
  --template <name>       shipped profile the two are created from (default headless)
  --pin-shell <path>      the PowerShell executable the baseline must use
                          (default %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe)
  --no-pin                leave the baseline's shell engine alone; it then resolves to
                          whatever PATH hands back — a PowerShell 7 (README §2.1)
  --plugin <spec>         what to install into the candidate: an npm spec (default
                          dsh-ops@<package.json version>), "local" for this checkout
                          (pnpm file: snapshot — reinstall after every change), or "none"
  --no-plugin             alias for --plugin none
  --reinstall             remove the plugin from the candidate before installing
  --dsh-home <dir>        isolate DSH_HOME (profiles + sessions) for the benchmark
  --dsh <path>            dsh's JS entry (lib/bin.js) or an executable; default: from PATH
  --force                 overwrite a pwshPath this script did not write
  --dry-run               plan only: print every write and command, change nothing`

/**
 * Everything this script can be told.
 * @typedef {object} Options
 * @property {string} baseProfile - the stock baseline profile name.
 * @property {string} candProfile - the candidate profile name.
 * @property {string} template - the shipped profile both are created from.
 * @property {string|null} pinShell - the executable to pin, null with --no-pin.
 * @property {string} plugin - an npm spec, "local", or "none".
 * @property {boolean} reinstall - remove the plugin before installing.
 * @property {string|null} dshHome - --dsh-home.
 * @property {string|null} dsh - --dsh.
 * @property {boolean} force - overwrite a foreign pwshPath.
 * @property {boolean} dryRun - plan only.
 * @property {boolean} help - print usage.
 */

/**
 * Parse the command line. An unknown flag is an error: a typo must not quietly prepare a
 * baseline with the wrong engine.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const options = {
    baseProfile: 'bench-base', candProfile: 'bench-ops', template: 'headless',
    // There is no Windows PowerShell to pin off Windows, and `dsh-pwsh-sandbox` is
    // Windows-gated in the composition anyway, so the default is "no pin" there.
    pinShell: process.platform === 'win32' ? defaultShellPath() : null,
    plugin: null, reinstall: false,
    dshHome: null, dsh: null, force: false, dryRun: false, help: false,
  }
  const values = {
    '--base-profile': 'baseProfile', '--cand-profile': 'candProfile', '--template': 'template',
    '--pin-shell': 'pinShell', '--plugin': 'plugin', '--dsh-home': 'dshHome', '--dsh': 'dsh',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (name === '--help') { options.help = true; continue }
    if (name === '--dry-run') { options.dryRun = true; continue }
    if (name === '--force') { options.force = true; continue }
    if (name === '--reinstall') { options.reinstall = true; continue }
    if (name === '--no-pin') { options.pinShell = null; continue }
    if (name === '--no-plugin') { options.plugin = 'none'; continue }
    const target = values[name]
    if (!target) throw new Error(`unknown option "${name}"`)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`${name} needs a value`)
    options[target] = value
  }
  options.plugin ??= `dsh-ops@${repoVersion()}`
  if (options.help) return options
  for (const [flag, value] of [['--base-profile', options.baseProfile], ['--cand-profile', options.candProfile]]) {
    if (!value) throw new Error(`${flag} needs a name`)
    if (SHIPPED_PROFILES.includes(value)) {
      throw new Error(`${flag} "${value}" is a shipped template name; bench profiles are created from it (PLAN §2.3)`)
    }
  }
  if (options.baseProfile === options.candProfile) throw new Error('--base-profile and --cand-profile must differ')
  if (options.pinShell && process.platform === 'win32' && !path.isAbsolute(options.pinShell)) {
    throw new Error(`--pin-shell must be an absolute path, got "${options.pinShell}"`)
  }
  return options
}

/** The documented stock shell on this machine's Windows install.
 * @returns {string} an absolute path to Windows PowerShell. */
function defaultShellPath() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The version of this checkout, which is also the default npm spec to install.
 * @returns {string} the version, or `latest` when package.json cannot be read. */
function repoVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? 'latest' } catch { return 'latest' }
}

/** The home dsh will use. Mirrors `run.mjs`, so the profiles prepared here are the
 * profiles the runner reads.
 * @param {Options} options - the options.
 * @returns {string} the absolute home. */
export function dshHomeFor(options) {
  if (options.dshHome) return path.resolve(options.dshHome)
  return path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

/**
 * Decide how to merge the pin into a profile patch layer, without a YAML library and
 * without rewriting a single character the script does not own.
 * @param {string} text - the current file content.
 * @param {string} value - the executable to pin.
 * @param {{force?: boolean}} [flags] - `force` allows overwriting a value this script
 *   did not write.
 * @returns {{action: 'write'|'noop'|'conflict'|'manual', text: string, note: string}}
 *   the plan: `write` carries the new file text, every other action leaves `text` as it
 *   was read.
 */
export function planProfilePatch(text, value, { force = false } = {}) {
  const entry = [`- id: ${SHELL_ENTRY_ID}`, '  config:', `    ${SHELL_CONFIG_KEY}: ${value}`]
  const lines = text.split(/\r?\n/)
  const content = lines.filter(line => line.trim() !== '' && !/^\s*#/.test(line))

  // A layer of comments only, or the template's `[]` placeholder: both are "nothing yet".
  if (content.length === 0) return { action: 'write', text: joinLines([...trimTrailingBlanks(lines), ...entry]), note: '这一层 patch 原本只有注释' }
  if (content.length === 1 && content[0].trim() === '[]') {
    return { action: 'write', text: joinLines(replace(lines, lines.findIndex(line => line.trim() === '[]'), 1, entry)), note: '替换了模板的 [] 占位' }
  }

  // Anything that is not a plain top-level list: refuse instead of guessing.
  if (!content.every(line => /^-\s/.test(line) || /^[ \t]+\S/.test(line))) {
    return { action: 'manual', text, note: '这一层不是普通的顶层列表，没敢猜它的结构' }
  }

  const found = collectEntries(lines).find(item => item.id === SHELL_ENTRY_ID)
  if (!found) return { action: 'write', text: joinLines([...trimTrailingBlanks(lines), ...entry]), note: `追加了一个 ${SHELL_ENTRY_ID} 条目` }

  const own = found.lines
  const keyAt = own.findIndex(line => new RegExp(`^\\s+${SHELL_CONFIG_KEY}:`).test(line))
  if (keyAt !== -1) {
    const current = own[keyAt].replace(new RegExp(`^\\s*${SHELL_CONFIG_KEY}:`), '').trim()
    if (samePath(current, value)) return { action: 'noop', text, note: `已经钉在 ${current}` }
    if (!force) return { action: 'conflict', text, note: `已有一条 ${SHELL_CONFIG_KEY}: ${current}，不是本脚本写的，不加 --force 不覆盖` }
    const line = own[keyAt].replace(new RegExp(`${SHELL_CONFIG_KEY}:.*`), `${SHELL_CONFIG_KEY}: ${value}`)
    return { action: 'write', text: joinLines(replace(lines, found.start + keyAt, 1, [line])), note: `把 ${SHELL_CONFIG_KEY} 换成 ${value}` }
  }

  const configAt = own.findIndex(line => /^[ \t]+config:[ \t]*$/.test(line))
  if (configAt !== -1) {
    const indent = /^[ \t]*/.exec(own[configAt])[0]
    return { action: 'write', text: joinLines(replace(lines, found.start + configAt + 1, 0, [`${indent}  ${SHELL_CONFIG_KEY}: ${value}`])), note: `在既有 config 块里加了 ${SHELL_CONFIG_KEY}` }
  }

  // No config block. An inline one is refused; a missing one gets appended inside the entry.
  if (own.some(line => /^[ \t]+config:\s*\S/.test(line))) {
    return { action: 'manual', text, note: `${SHELL_ENTRY_ID} 的 config 是内联写法，手写一行比脚本改写安全` }
  }
  const last = found.start + own.reduce((keep, line, offset) => (line.trim() === '' ? keep : offset), -1)
  return { action: 'write', text: joinLines(replace(lines, last + 1, 0, entry.slice(1))), note: `给已有的 ${SHELL_ENTRY_ID} 条目补了 config 块` }
}

/** Split a top-level list into entries, each with its line range and the lines it owns.
 * @param {string[]} lines - the file lines.
 * @returns {{id: string|null, start: number, end: number, lines: string[]}[]} one per entry. */
function collectEntries(lines) {
  const starts = lines.map((line, index) => (/^- /.test(line) ? index : -1)).filter(index => index !== -1)
  return starts.map((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1] : lines.length
    const own = lines.slice(start, end)
    const id = own.map(line => /^\s*-?\s*id:\s*(.+)$/.exec(line)).find(match => match)?.[1]?.trim() ?? null
    return { id, start, end, lines: own }
  })
}

/** Replace `count` lines at `at` (or insert when count is 0) with `add`.
 * @param {string[]} lines - the file lines.
 * @param {number} at - the index.
 * @param {number} count - how many lines to drop.
 * @param {string[]} add - the lines to put in their place.
 * @returns {string[]} a new array; the input is never mutated. */
function replace(lines, at, count, add) {
  return [...lines.slice(0, at), ...add, ...lines.slice(at + count)]
}

/** Drop trailing blank lines so an appended entry sits against the list.
 * @param {string[]} lines - the file lines.
 * @returns {string[]} the lines without trailing blanks. */
function trimTrailingBlanks(lines) {
  const out = [...lines]
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/** Join lines into a file text with exactly one trailing newline.
 * @param {string[]} lines - the file lines.
 * @returns {string} the text. */
function joinLines(lines) { return `${lines.join('\n')}\n` }

/** Compare two Windows paths, ignoring case and separators.
 * @param {string} left - one path, possibly quoted.
 * @param {string} right - the other path.
 * @returns {boolean} whether they name the same executable. */
function samePath(left, right) {
  const clean = value => value.replace(/^['"]|['"]$/g, '').replace(/[\\/]/g, '\\').toLowerCase()
  return clean(left) === clean(right)
}

/** Run a command and capture it, without a shell. `dsh`'s Windows PATH entry is a `.cmd`
 * wrapper Node cannot spawn with captured pipes anyway, so callers pass `lib/bin.js`.
 * @param {string} command - the executable.
 * @param {string[]} args - its argv.
 * @param {Record<string, string|undefined>} env - its environment.
 * @returns {{status: number|null, stdout: string, stderr: string, errorCode: string|null}} the outcome. */
function runCapture(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code ?? null }
}

/** What to spawn for a resolved entry.
 * @param {{file: string, kind: 'js'|'exe'}} entry - the resolved launcher.
 * @returns {{command: string, prefix: string[]}} the command and its argv prefix. */
function launcher(entry) {
  return entry.kind === 'js' ? { command: process.execPath, prefix: [entry.file] } : { command: entry.file, prefix: [] }
}

/** The plugin version installed in a profile, read from its dependency tree.
 * @param {string} home - the DSH_HOME in play.
 * @param {string} profile - the profile name.
 * @returns {string|null} the version, or null when the plugin is absent. */
export function installedPlugin(home, profile) {
  try {
    const manifest = path.join(home, 'profiles', profile, 'node_modules', 'dsh-ops', 'package.json')
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null
  } catch { return null }
}

/**
 * Create a profile from the shipped template when it does not exist yet.
 * @param {string} name - the profile name.
 * @param {object} context - the run context: home, template, dryRun, log, invoke.
 * @returns {'created'|'exists'|'failed'} what happened. */
function ensureProfile(name, context) {
  const dir = path.join(context.home, 'profiles', name)
  if (fs.existsSync(dir)) { context.log(`  ${name}: 已存在，跳过创建`); return 'exists' }
  const args = [...context.prefix, name, '--from-default-profile', context.template, '--dump-config']
  if (context.dryRun) { context.log(`  ${name}: 计划执行 ${describe(args)}`); return 'created' }
  const result = context.invoke(args)
  if (result.status !== 0) {
    context.log(`  ${name}: 创建失败 exit=${result.status} — ${(result.stderr || result.stdout).trim().split('\n')[0]}`)
    return 'failed'
  }
  context.log(`  ${name}: 已从 ${context.template} 创建`)
  return 'created'
}

/**
 * Apply the pin plan to the baseline profile's patch layer.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'|'skipped'} the outcome. */
function pinBaseline(options, context) {
  if (!options.pinShell) {
    context.log('  --no-pin：没动。基线会命中 PATH 上的 pwsh 别名（README §2.1），两侧就都是 PowerShell 7')
    return 'skipped'
  }
  const file = path.join(context.home, 'profiles', options.baseProfile, 'cordis.patch.yml')
  if (!fs.existsSync(file)) {
    // In a plan for a home that has no such profile yet, the file is created by step 1,
    // so its absence is the expected state rather than a failure.
    if (context.dryRun && !fs.existsSync(path.join(context.home, 'profiles', options.baseProfile))) {
      context.log(`  [dry-run] 计划：profile 建好之后把 ${SHELL_CONFIG_KEY} 写进 ${file}`)
      return 'pinned'
    }
    context.log(`  找不到 ${file}`)
    return 'absent'
  }
  const plan = planProfilePatch(fs.readFileSync(file, 'utf8'), options.pinShell, { force: options.force })
  if (plan.action === 'noop') { context.log(`  ${plan.note}`); return 'noop' }
  if (plan.action === 'conflict' || plan.action === 'manual') {
    context.log(`  ${plan.note}`)
    context.log(`  手工做法：编辑 ${file}，让里面 ${SHELL_ENTRY_ID} 的 ${SHELL_CONFIG_KEY} 取下值（没有就加，有别的值就改掉；文件里的 [] 占位直接换成这三行）`)
    context.log(`    - id: ${SHELL_ENTRY_ID}\n      config:\n        ${SHELL_CONFIG_KEY}: ${options.pinShell}`)
    return plan.action
  }
  if (context.dryRun) { context.log(`  计划写入 ${file} — ${plan.note}`); return 'pinned' }
  fs.writeFileSync(file, plan.text, 'utf8')
  context.log(`  ${plan.note} → ${options.pinShell}`)
  return 'pinned'
}

/**
 * Install (or deliberately leave) the plugin under test in the candidate profile.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'installed'|'present'|'skipped'|'failed'} the outcome. */
function prepareCandidate(options, context) {
  const installed = installedPlugin(context.home, options.candProfile)
  if (options.plugin === 'none') {
    context.log(installed ? `  已装 dsh-ops@${installed}，--no-plugin 没动它` : '  --no-plugin：候选 profile 里也没有 dsh-ops，候选侧还没法测')
    return installed ? 'present' : 'skipped'
  }
  const spec = options.plugin === 'local' ? REPO_ROOT : options.plugin
  if (installed && !options.reinstall) {
    context.log(`  已装 dsh-ops@${installed}（本仓库 ${repoVersion()}）。checkout 改过就加 --reinstall：pnpm file: 是快照拷贝，不重装测的还是旧代码（README §2）`)
    return 'present'
  }
  const steps = installed && options.reinstall ? [['remove', 'dsh-ops'], ['add', spec]] : [['add', spec]]
  for (const [verb, target] of steps) {
    const args = [...context.prefix, 'plugin', '--profile', options.candProfile, verb, target]
    if (context.dryRun) { context.log(`  计划执行 ${describe(args)}`); continue }
    context.log(`  dsh plugin ${verb} ${target} …（透传 pnpm，可能要点时间）`)
    const result = context.invoke(args)
    if (result.status !== 0) {
      const hint = result.errorCode === 'ENOENT' ? '（命令起不来）' : ''
      context.log(`  失败 exit=${result.status} ${hint}— ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n  ')}`)
      context.log('  提示：pnpm 不在 PATH 上时 dsh plugin 会 exit 127（PLAN §2.3）')
      return 'failed'
    }
  }
  context.log(`  候选侧装的是 ${options.plugin === 'local' ? `本地 checkout ${REPO_ROOT}` : spec}，运行时会把 pwshPath 注入成插件自带 pwsh`)
  return 'installed'
}

/** Render a planned command line for humans, dropping the bin.js argument.
 * @param {string[]} args - the full argv including the entry file.
 * @returns {string} the printable form. */
function describe(args) {
  return `dsh ${args.filter(arg => arg !== process.execPath && !/bin\.js$/.test(arg)).join(' ')}`
}

/**
 * Read the composed tree back: the only proof that the pin actually landed, because a
 * patch whose id the loader does not know is warned about and skipped silently.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {boolean} whether the baseline really got the requested engine. */
function verifyBaseline(options, context) {
  if (!options.pinShell) return true
  const overlay = path.join(BENCH_DIR, 'llm.patch.yml')
  const args = [...context.prefix, '--profile', options.baseProfile]
  if (fs.existsSync(overlay)) args.push('--patch', overlay)
  args.push('--dump-config')
  const result = context.invoke(args)
  if (result.status !== 0) {
    context.log(`  "dsh --profile ${options.baseProfile} --dump-config" exit=${result.status}，没能读到组合树`)
    return false
  }
  const pinned = `${result.stdout}\n${result.stderr}`.match(/pwshPath:\s*(.+)$/m)?.[1]?.trim() ?? null
  if (pinned && samePath(pinned, options.pinShell)) {
    context.log(`  基线组合树里 ${SHELL_ENTRY_ID}.config.${SHELL_CONFIG_KEY} = ${pinned} ✅（overlay 层压得住 profile 层）`)
    return true
  }
  context.log(pinned
    ? `  基线实际生效的是 ${pinned}，和要求的 ${options.pinShell} 不一致 ❌`
    : `  组合树里没有 ${SHELL_CONFIG_KEY} ❌ —— 基线会命中 PATH 上的 pwsh 别名，不是 Windows 原装 5.1`)
  return false
}

/**
 * The whole preparation.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Promise<number>} the process exit code: 0 prepared, 1 a step failed, 2 usage. */
export async function main(argv) {
  let options
  try { options = parseArgs(argv) } catch (error) { console.error(`${error.message}\n\n${USAGE}`); return 2 }
  if (options.help) { console.log(USAGE); return 0 }

  const blocked = pipedSpawnBlocker()
  if (blocked) {
    console.error(`这个会话读不了子进程的 stdout（${blocked}）。请在普通终端里跑：本脚本要靠管道读 dsh --dump-config。`)
    return 1
  }

  let entry
  try { entry = resolveDshEntry(options.dsh) } catch (error) { console.error(error.message); return 1 }
  const { command, prefix } = launcher(entry)
  const home = dshHomeFor(options)
  const env = { ...process.env, ...(options.dshHome ? { DSH_HOME: home } : {}) }
  const invoke = args => {
    // spawnSync cannot stream: the three minutes a cold `pnpm install` takes look like a
    // dead machine unless the script says what it is waiting on and how long it waited.
    // Timing every call is the cheapest possible heartbeat.
    const started = Date.now()
    const result = runCapture(command, args, env)
    const took = Math.max(1, Date.now() - started)
    log(`  ↳ ${describe(args)} → exit=${result.status ?? `起不来（${result.errorCode ?? '?'}）`}，用时 ${took < 1000 ? `${took}ms` : `${(took / 1000).toFixed(1)}s`}`)
    return result
  }
  const log = line => console.log(line)
  const context = { home, log, invoke, prefix, dryRun: options.dryRun, template: options.template }

  log(`dsh 入口: ${entry.kind === 'js' ? entry.file : `${entry.file} (exe)`}`)
  if (entry.notes.length) log(`  怎么找到的: ${entry.notes.join('；')}`)
  log(`DSH_HOME: ${home}`)
  log(`node ${process.version}，平台 ${process.platform}-${process.arch}${options.dryRun ? '，[--dry-run] 只看计划' : ''}`)

  const warnings = []
  const poison = poisonedModulePath(process.env.PSModulePath)
  if (poison) {
    warnings.push(`PSModulePath 里 ${poison} 排在 Windows PowerShell 自己的 Modules 之前：dsh-ops 的工作区准备脚本会死在 Get-Acl 上，候选侧每一个 pwsh / bash / run_code 调用都会在模型的命令跑起来之前失败（README §1）。换一个 cmd.exe 窗口重开这条命令。`)
  }
  if (process.platform !== 'win32' && options.pinShell) {
    warnings.push(`当前不是 Windows：--pin-shell 指的 Windows PowerShell 路径在这台机器上不存在，考虑 --no-pin。`)
  }
  const homePatch = path.join(home, 'cordis.patch.yml')
  if (fs.existsSync(homePatch) && fs.readFileSync(homePatch, 'utf8').trim() !== '') {
    warnings.push(`${homePatch} 存在且非空：home 层会组合进每一个 profile 并压过 profile 层，基线可能已经不 stock（README §6）。用 --dsh-home 隔离，或把它清空。`)
  }
  if (!fs.existsSync(path.join(BENCH_DIR, 'llm.patch.yml'))) {
    warnings.push('bench/llm.patch.yml 还不存在：先 copy bench\\llm.patch.example.yml bench\\llm.patch.yml 并填服务器与模型（README §2 步骤 3）。')
  }

  log('\n— 1) profile —')
  const base = ensureProfile(options.baseProfile, context)
  const cand = ensureProfile(options.candProfile, context)
  if (base === 'failed' || cand === 'failed') return 1

  log('\n— 2) 基线 shell 引擎 —')
  const pin = pinBaseline(options, context)

  log('\n— 3) 候选插件 —')
  const plugin = prepareCandidate(options, context)

  log('\n— 4) 回读组合树 —')
  let installedNow = installedPlugin(home, options.candProfile)
  let verified = true
  if (options.dryRun) {
    log('  [dry-run] 跳过回读：真跑时会用 dsh --dump-config 确认基线那行 pwshPath')
  } else {
    verified = verifyBaseline(options, context)
    installedNow = installedPlugin(home, options.candProfile)
    if (options.plugin !== 'none') {
      log(installedNow ? `  候选 profile 里 dsh-ops@${installedNow} ✅` : '  候选 profile 里读不到 dsh-ops ❌（node_modules/dsh-ops/package.json 不在）')
    }
  }

  for (const warning of warnings) console.warn(`\n*** ${warning}`)

  log('\n— 下一步 —')
  log('  node bench/run.mjs --dry-run --label selfcheck --profile selfcheck')
  // The run label now matches the profile it came from, so the archived directory names
  // read the same as `dsh --profile <name>` does, and --base-profile/--cand-profile carry
  // straight through into the suggested commands.
  log(`  node bench/run.mjs --label ${options.baseProfile} --profile ${options.baseProfile} --repeat 3`)
  log(`  node bench/run.mjs --label ${options.candProfile} --profile ${options.candProfile} --repeat 3`)
  log(`  node bench/compare.mjs ${options.baseProfile} ${options.candProfile} --fail-on both --json bench\\runs\\compare.json`)
  log('  （冒烟先看 README §3：usage 有没有回报、候选侧 pwsh 是不是活着，再开正式跑分）')

  // A deliberate --no-plugin leaves the candidate unprepared without being a failure; a
  // plugin that was asked for and is still missing is one, because bench-ops cannot run.
  const unresolved = [
    pin === 'conflict' ? 'pwshPath 已有别的值（要覆盖就 --force）' : '',
    pin === 'manual' ? '基线 patch 文件的形状需要手工处理（上面印了要贴的三行）' : '',
    pin === 'absent' ? '基线 profile 的 cordis.patch.yml 找不到' : '',
    plugin === 'failed' ? '插件安装失败' : '',
    options.plugin !== 'none' && !options.dryRun && !installedNow ? '候选 profile 里没有 dsh-ops，bench-ops 无从测起' : '',
    verified ? '' : '基线 shell 引擎没验证上',
  ].filter(Boolean)
  if (options.plugin === 'none' && !installedNow) {
    console.warn('\n*** 候选 profile 里没有 dsh-ops（--no-plugin 是你自己给的）：装上之后再跑 bench-ops。')
  }
  if (unresolved.length > 0) {
    console.error(`\n准备没做完：${unresolved.join('；')}`)
    return 1
  }
  log(options.dryRun ? '\n[dry-run] 以上全是计划，没有改动任何文件。' : '\n准备完成。')
  return 0
}

/** Let other modules import this file without running it.
 * @returns {void} */
async function run() {
  process.exitCode = await main(process.argv.slice(2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await run()
