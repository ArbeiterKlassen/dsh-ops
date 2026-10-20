#!/usr/bin/env node
/**
 * The comparison report: two archived runs in, one `report.md` out.
 *
 * The verdict is *not* computed here. `lib/compare-core.mjs` owns every rule — pass
 * rate first, cost only over pairs that passed on both sides, and a direction only
 * when the measured delta clears the A/A noise floor — and this file only resolves
 * the two sides, calls it, and renders what it returned. With no noise floor the
 * report says so and abstains from every cost direction (`noise-floor-unknown`).
 *
 * The report opens with its fixed title and then the evidence a reviewer works
 * through — the per-task paired table, the pairs a failed side forced out of the cost
 * statistics, the A/A band, and the diagnostic sections #183 carried (per-task bucket
 * detail, the usage-bucket split and the token attribution), which say *why* the
 * number moved (a bigger per-request prompt is a tool-schema cost, extra steps are a
 * model-behaviour cost, fatter tool results are a context cost; the fixes are
 * opposite, so the report has to say which one it was) — and closes with the conclusion:
 * pass rate, paired token Δ, the noise band, whether a direction is readable and the
 * gate. None of the diagnostics can change the gate.
 *
 * Time is evidence only: the comparison never reads `durationMs`, and nothing here
 * turns a duration into a verdict.
 *
 * @module dsh-ops/bench/compare
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGGREGATES,
  COMPARE_FORMAT,
  FAIL_ON,
  REGRESSION_SCOPES,
  compareSummaries,
  formatNumber,
  percentChange,
} from './lib/compare-core.mjs'
import { RUNS_DIR } from './lib/next-folder.mjs'

/** The sealed contract document inside a run directory. */
const SEALED_RUN = 'run.json'
/** #183's older summary document, still accepted as a side. */
const LEGACY_SUMMARY = 'summary.json'
/** The summary document's format tag. */
const SUMMARY_FORMAT = 'dsh-ops-bench-summary-v1'
/** The report's fixed title; the two sides are named in Evidence, not in the heading. */
const REPORT_TITLE = '# DSH-OPS Benchmark Report'
/** The panel's palette: `report.md` and `panel.html` must agree on what green and red mean. */
const GREEN = '#3fb950'
const RED = '#f85149'

/**
 * Exit codes, kept in step with `EXIT` in `bench/cli.mjs` (which forwards whatever
 * `main` returns): the A/B comparison's exit code *is* its verdict.
 */
export const EXIT = { ok: 0, failure: 1, usage: 2 }

const USAGE = `usage: node bench/compare.mjs <base> <cand> [options]

  <base> <cand>      each side is one of:
                       <label>   a run label, matched against bench/runs/*-<label>
                                 and one level of bench/runs/<folder>/*-<label>
                                 groups (the newest stamp wins)
                       <dir>     a run directory (run.json, else summary.json)
                       <file>    a run.json or summary.json path
  --folder <name>    restrict label matching to bench/runs/<name>/
  --runs <dir>       override the runs root (default bench/runs)
  --aggregate S      median (default) or min: the statistic the deltas compare
  --tolerance-pct N  token regression tolerance in percent (default 2)
  --fail-on MODE     regression | pass-drop | both (default) | none
  --regression-scope S  task (default) | total | both
  --noise-floor-pct N   pin the A/A noise floor; without a floor every cost
                     direction is withheld (noise-floor-unknown)
  --noise <a> <b>    measure the A/A noise floor from two baseline runs
  --json             print the comparison document as JSON instead of the report
  --out <file>       where the rendered artifact goes (default <cand dir>/report.md;
                     "-" is stdout only). With --json the file carries the JSON.
  --help             this text

Exit codes: 0 ok (or a gate that abstained) · 1 a gate failed · 2 usage/input error`

/**
 * The parsed command line.
 * @typedef {object} Options
 * @property {string|null} base - the baseline side spec.
 * @property {string|null} cand - the candidate side spec.
 * @property {string|null} folder - restrict label matching to one group directory.
 * @property {string} runsDir - where run directories live.
 * @property {'median'|'min'} aggregate - the statistic to compare.
 * @property {number} tolerancePct - the regression tolerance.
 * @property {'regression'|'pass-drop'|'both'|'none'} failOn - the gate.
 * @property {'task'|'total'|'both'} regressionScope - what the regression gate judges.
 * @property {number|null} noiseFloorPct - an externally pinned A/A floor.
 * @property {string[]|null} noise - two A/A side specs to measure the floor from.
 * @property {boolean} json - print the comparison document instead of the report.
 * @property {string|null} out - report path, `-` for stdout only, null for the default.
 * @property {boolean} help - whether `--help` was asked for.
 */

/**
 * Parse the command line. A malformed flag throws; `main` turns that into exit 2.
 * @param {string[]} argv - the arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const positional = []
  const options = {
    base: null,
    cand: null,
    folder: null,
    runsDir: RUNS_DIR,
    aggregate: 'median',
    tolerancePct: 2,
    failOn: 'both',
    regressionScope: 'task',
    noiseFloorPct: null,
    noise: null,
    json: false,
    out: null,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      const inline = eq === -1 ? null : arg.slice(eq + 1)
      const take = () => {
        if (inline !== null) return inline
        index += 1
        if (index >= argv.length) throw new Error(`${name} needs a value`)
        return argv[index]
      }
      if (name === '--json') {
        if (inline !== null) throw new Error('--json takes no value; the comparison document goes to stdout and --out names a file')
        options.json = true
      } else if (name === '--aggregate') options.aggregate = take()
      else if (name === '--tolerance-pct') options.tolerancePct = Number(take())
      else if (name === '--fail-on') options.failOn = take()
      else if (name === '--regression-scope') options.regressionScope = take()
      else if (name === '--noise-floor-pct') options.noiseFloorPct = Number(take())
      else if (name === '--noise') {
        const first = take()
        index += 1
        if (index >= argv.length) throw new Error('--noise needs two sides: --noise <base> <cand>')
        options.noise = [first, argv[index]]
      } else if (name === '--out') options.out = take()
      else if (name === '--folder') options.folder = assertFolderName(take(), '--folder')
      else if (name === '--runs') options.runsDir = path.resolve(take())
      else throw new Error(`unknown option "${name}"`)
      continue
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option "${arg}"`)
    positional.push(arg)
  }
  if (!AGGREGATES.includes(options.aggregate)) throw new Error(`--aggregate must be one of ${AGGREGATES.join(', ')}`)
  if (!FAIL_ON.includes(options.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(', ')}`)
  if (!REGRESSION_SCOPES.includes(options.regressionScope)) throw new Error(`--regression-scope must be one of ${REGRESSION_SCOPES.join(', ')}`)
  if (!Number.isFinite(options.tolerancePct) || options.tolerancePct < 0) throw new Error('--tolerance-pct must be a non-negative number')
  if (options.noiseFloorPct !== null && (!Number.isFinite(options.noiseFloorPct) || options.noiseFloorPct < 0)) {
    throw new Error('--noise-floor-pct must be a non-negative number')
  }
  if (options.help) return options
  if (positional.length !== 2) throw new Error('expected exactly two sides: <base> <cand>')
  options.base = positional[0]
  options.cand = positional[1]
  return options
}

/**
 * A `--folder` name must be one flat, safe directory segment under the runs root.
 * @param {string} name - the requested folder name.
 * @param {string} flag - the flag it came from, for the error text.
 * @returns {string} the validated name.
 */
function assertFolderName(name, flag) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes(':')) {
    throw new Error(`${flag} must be one safe directory name (no path separators, no "." or ".."), got "${name}"`)
  }
  return name
}

/** Whether a path exists and is a directory. */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path exists and is a file. */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * Read and identify one side's document.
 *
 * Two shapes exist in this repo and both are accepted: the sealed `run.json`
 * (`schemaVersion: 1`, `results` rows) and #183's summary. Anything else is refused
 * loudly rather than silently compared as an empty document.
 * @param {string} file - the document path.
 * @returns {{doc: object, file: string, dir: string, kind: 'run'|'summary'}} the side document.
 */
function readSide(file) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: not readable as JSON (${error.message})`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: not a JSON object`)
  const sealed = doc.schemaVersion === 1 && Array.isArray(doc.results)
  if (sealed) return { doc, file, dir: path.dirname(file), kind: 'run' }
  if (doc.format === SUMMARY_FORMAT && Array.isArray(doc.results)) return { doc, file, dir: path.dirname(file), kind: 'summary' }
  const saw = typeof doc.format === 'string' ? `format "${doc.format}"` : `schemaVersion ${JSON.stringify(doc.schemaVersion)}`
  throw new Error(`${file}: unrecognised document (want a sealed run.json with schemaVersion 1 or a summary with format "${SUMMARY_FORMAT}", saw ${saw})`)
}

/**
 * Resolve one side of the comparison.
 *
 * Three forms, in the order #183 made convenient: an existing directory (preferring
 * `run.json` over `summary.json`), an existing file, or a label matched against the
 * runs root and one level of group directories (the newest stamp wins — a comparison
 * is about the latest measured state of each side).
 * @param {string} spec - a label, a run directory, or a document path.
 * @param {object} [options] - `{runsDir, folder}`.
 * @returns {{doc: object, file: string, dir: string, kind: 'run'|'summary', spec: string}} the resolved side.
 */
export function resolveSide(spec, options = {}) {
  const runsDir = options.runsDir ?? RUNS_DIR
  const folder = options.folder ?? null
  const direct = path.resolve(spec)
  if (isDirectory(direct)) {
    const file = [SEALED_RUN, LEGACY_SUMMARY]
      .map((name) => path.join(direct, name))
      .find((candidate) => fs.existsSync(candidate))
    if (!file) throw new Error(`${direct}: a directory, but it has no ${SEALED_RUN} and no ${LEGACY_SUMMARY}`)
    return { ...readSide(file), spec }
  }
  if (isFile(direct)) return { ...readSide(direct), spec }
  return { ...readSide(findLabel(spec, runsDir, folder)), spec }
}

/**
 * Find the newest archived run whose directory name is, or ends in, the label.
 * @param {string} spec - the label.
 * @param {string} runsDir - the runs root.
 * @param {string|null} folder - one group directory to search instead of the root
 *   plus one level of groups.
 * @returns {string} the document path.
 */
function findLabel(spec, runsDir, folder) {
  if (!isDirectory(runsDir)) {
    throw new Error(`no runs directory at ${runsDir}; pass a run directory or a ${SEALED_RUN}/${LEGACY_SUMMARY} path instead of the label "${spec}"`)
  }
  let roots
  if (folder !== null) {
    roots = [path.join(runsDir, folder)]
    if (!isDirectory(roots[0])) throw new Error(`no run folder "${folder}" at ${roots[0]}`)
  } else {
    roots = [runsDir]
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(runsDir, entry.name))
    }
  }
  const matches = []
  for (const root of roots) {
    let names
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (name !== spec && !name.endsWith(`-${spec}`)) continue
      const dir = path.join(root, name)
      if (!isDirectory(dir)) continue
      for (const fileName of [SEALED_RUN, LEGACY_SUMMARY]) {
        const candidate = path.join(dir, fileName)
        if (fs.existsSync(candidate)) {
          matches.push({ name, file: candidate })
          break
        }
      }
    }
  }
  if (matches.length === 0) {
    const where = folder === null ? runsDir : path.join(runsDir, folder)
    throw new Error(`"${spec}" is neither a run directory, a ${SEALED_RUN}/${LEGACY_SUMMARY} path, nor a label with an archived run under ${where}`)
  }
  matches.sort((left, right) => (left.name === right.name ? left.file.localeCompare(right.file) : left.name < right.name ? -1 : 1))
  return matches[matches.length - 1].file
}

/** The U+2212 minus sign, so a negative delta reads as a sign rather than a hyphen. */
const MINUS = '\u2212'

/** A thousands-separated integer, `n/a` when it is not a number. */
function number(value) {
  return formatNumber(value)
}

/**
 * A step or tool-call count: an integer, or one decimal when an even repeat count
 * halves the median. Rounding 12.5 → 13 would print "13 → 13 (+4.0%)", a cell that
 * contradicts its own Δ%.
 * @param {number|null} value - the count.
 * @returns {string} the display form.
 */
function count(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return Number.isInteger(value) ? formatNumber(value) : value.toFixed(1)
}

/** A signed integer delta with grouping, for the diagnostic tables. */
function signed(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : rounded < 0 ? MINUS : ''}${Math.abs(rounded).toLocaleString('en-US')}`
}

/**
 * Paint every percent inside a string the core produced. Gate reasons and warnings are
 * quoted verbatim — the digits stay the core's, only the colour is added — so they read
 * in the same two colours as the percents this module formats itself.
 * @param {string} text - the core's string.
 * @returns {string} the same text, percents wrapped.
 */
function paintPercents(text) {
  return text.replace(/[+-]?\d+(?:\.\d+)?%/g, (whole) => color(whole, Number.parseFloat(whole)))
}

/**
 * A count painted red for a reason that is not a sign: the plugin side reached for a
 * tool this plugin does not publish.
 * @param {string} text - the rendered count.
 * @returns {string} the HTML span.
 */
function alarm(text) {
  return `<span style="color:${RED}">${text}</span>`
}

/**
 * Paint one rendered value: a drop (or no change) is green, a rise is red — the same
 * two colours `panel.html` uses, inline because a markdown file cannot carry a
 * stylesheet. A value with no number behind it is returned unwrapped.
 * @param {string} text - the rendered value.
 * @param {number|null} value - the signed number behind it.
 * @returns {string} the HTML span, or `text`.
 */
function color(text, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return text
  return `<span style="color:${value > 0 ? RED : GREEN}">${text}</span>`
}

/** A signed percent at the module's reporting precision, painted by its sign. */
function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return color(`${value > 0 ? '+' : value < 0 ? MINUS : ''}${Math.abs(value).toFixed(1)}%`, value)
}

/**
 * A percent the core stated as a bare number — a band half-width, a tolerance, a share
 * of the delta. Printed verbatim (no sign is invented) and painted like every other
 * percent in the report.
 * @param {number|null} value - the number, with `%` appended as-is.
 * @returns {string} the painted text.
 */
function rawPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return color(`${value}%`, value)
}

/** The short verdict name for one task's cost conclusion. */
function directionLabel(cost, regressed) {
  if (regressed) return '⚠ regression'
  switch (cost?.conclusion) {
    case 'cheaper': return 'cheaper'
    case 'costlier': return 'costlier'
    case 'within-noise': return 'within noise'
    case 'noise-floor-unknown': return 'abstain (noise floor unknown)'
    case 'incomparable': return 'incomparable'
    default: return 'no change'
  }
}

/**
 * The direction sentence — the one place the three noise outcomes are worded.
 * The core's conclusion names travel verbatim so the report and the JSON cannot drift.
 * @param {object} cost - `verdict.cost` from the comparison.
 * @returns {string} the sentence.
 */
function directionSentence(cost) {
  if (cost.conclusion === 'incomparable') {
    return 'Direction: no pair passed on both sides with complete usage ⇒ cost is incomparable; no direction is read'
  }
  if (cost.conclusion === 'noise-floor-unknown') {
    return `Direction: Δ ${percent(cost.pct)}, but the noise floor is unknown ⇒ abstaining, no direction is read (noise-floor-unknown); supply one with --noise-floor-pct N or --noise <base> <cand>`
  }
  if (cost.conclusion === 'within-noise') {
    return `Direction: Δ ${percent(cost.pct)} sits inside the noise band ±${rawPercent(cost.noiseFloorPct)} ⇒ interval only, no direction is read (within-noise)`
  }
  if (cost.conclusion === 'cheaper' || cost.conclusion === 'costlier') {
    return `Direction: Δ ${percent(cost.pct)}, beyond the noise floor ±${rawPercent(cost.noiseFloorPct)} ⇒ readable direction: ${cost.conclusion}`
  }
  return `Direction: Δ ${percent(cost.pct)}, no readable direction (${cost.conclusion ?? 'no-change'})`
}

/**
 * The conclusion that closes the report: pass rate, paired token Δ, noise floor, direction
 * and gate, in that order, plus the reasons the gate gave. It ends the document, so a
 * reviewer meets the verdict after the evidence instead of before it.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function verdictSection(comparison) {
  const { gate, totals, verdict, noiseFloor } = comparison
  const passes = `${totals.basePasses}/${totals.baseRuns} → ${totals.candPasses}/${totals.candRuns}`
  const pairs = `${gate.usablePairs}/${gate.usablePairs + gate.excludedPairs}`
  const tokenLine = gate.tokensComparable && gate.costComparable
    ? `💰 tokens (paired ${pairs}): ${number(totals.baseGrandTotal)} → ${number(totals.candGrandTotal)}, Δ ${percent(totals.grandTotalPct)}`
    : `💰 tokens: incomparable (${gate.tokensComparable ? `no pair passed on both sides, ${gate.excludedPairs} pair(s) excluded` : 'usage incomplete on at least one side'})`
  const gateLine = gate.fail ? `🚦 failed (${gate.primary})` : '🚦 passed'
  const lines = [
    '## Conclusion',
    '',
    `- pass rate: ${passes}${gate.passDropFailed ? ' (drop; decided before cost)' : totals.candPassRate > totals.basePassRate ? ' (up)' : ' (flat)'}`,
    `- ${tokenLine.replace('💰 ', '')}`,
    `- noise floor (A/A): ${noiseFloor.comparable ? `±${rawPercent(noiseFloor.pct)}, method \`${noiseFloor.method}\`` : 'unknown (noise-floor-unknown)'}`,
    `- ${directionSentence(verdict.cost)}`,
    `- gate: ${gateLine} · \`--fail-on ${gate.failOn}\` · regression scope \`${gate.regressionScope}\` · tolerance ${rawPercent(gate.tolerancePct)} · cost basis \`${gate.costBasis}\``,
    `- basis: ${comparison.aggregate} · profile ${comparison.base.profile ?? '?'} → ${comparison.cand.profile ?? '?'} · model ${comparison.base.model ?? '?'} → ${comparison.cand.model ?? '?'}`,
  ]
  for (const reason of gate.reasons) lines.push(`- reason: ${paintPercents(reason)}`)
  return lines
}

/**
 * The per-task paired table: cost plus the pass migration a reviewer scans for.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function taskSection(comparison) {
  const { gate, totals } = comparison
  const lines = [
    '## Per-task pairs',
    '',
    'Cost counts only pairs that passed on both sides (`paired-both-passed`); Δ% is the change in paired cost, not the mean over every repeat.',
    '',
    '| task | base | cand | Δ% | pairs usable/counted | excluded | pass base→cand | direction |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    const pair = task.paired
    const name = task.inBase && task.inCand ? task.id : `${task.id}${task.inBase ? '(base only)' : '(cand only)'}`
    lines.push(`| ${name} | ${number(pair.baseValue)} | ${number(pair.candValue)} | ${percent(pair.pct)} | ${pair.pairs}/${pair.considered} | ${pair.excluded.total} | ${task.base.passed}/${task.base.repeats}→${task.cand.passed}/${task.cand.repeats} | ${directionLabel(task.cost, task.regressed)} |`)
  }
  const totalPairs = `${gate.usablePairs}/${gate.usablePairs + gate.excludedPairs}`
  lines.push(`| **TOTAL** | ${number(totals.baseGrandTotal)} | ${number(totals.candGrandTotal)} | ${percent(totals.grandTotalPct)} | ${totalPairs} | ${gate.excludedPairs} | ${totals.basePasses}/${totals.baseRuns}→${totals.candPasses}/${totals.candRuns} | ${directionLabel(comparison.verdict.cost, false)} |`)
  lines.push(`| **geomean Δ** | — | — | ${percent(totals.grandTotalGeomeanPct)} | — | — | — | equal weight per task |`)
  return lines
}

/**
 * The pairs a failed side forced out of the cost statistics — the count the issue
 * requires to be visible, so a run cannot shrink its own denominator quietly.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function excludedSection(comparison) {
  const { excluded } = comparison.pairing
  const lines = ['## Excluded pairs (not in cost)', '']
  if (excluded.total === 0) {
    lines.push('No pairs were excluded: every pair that passed on both sides counted toward cost.')
  } else {
    lines.push(`Excluded ${excluded.total} pair(s) because at least one side failed: base failed ${excluded.baseFailed} · cand failed ${excluded.candFailed} · both failed ${excluded.bothFailed}.`, '')
    lines.push('| task | excluded | base failed | cand failed | both failed |', '| --- | --- | --- | --- | --- |')
    for (const task of comparison.tasks) {
      const counts = task.paired.excluded
      if (counts.total === 0) continue
      lines.push(`| ${task.id} | ${counts.total} | ${counts.baseFailed} | ${counts.candFailed} | ${counts.bothFailed} |`)
    }
  }
  const counts = comparison.pairing.counts
  lines.push(
    '',
    `Pairing: keys ${counts.pairs} · missing base ${counts.missingBase} · missing cand ${counts.missingCand} · duplicate keys ${counts.duplicates} · label mismatches ${counts.labelMismatches} · invalid rows ${counts.invalid}; merge ${comparison.pairing.complete ? 'complete' : 'incomplete'}.`,
  )
  return lines
}

/**
 * The A/A band: what "nothing changed" looked like, or an explicit statement that
 * it is unknown and every direction is therefore withheld.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function noiseSection(comparison) {
  const noise = comparison.noiseFloor
  const lines = ['## A/A noise band', '']
  if (!noise.comparable) {
    lines.push(
      'The noise floor is unknown ⇒ there is no readable interval, and every cost direction is withheld (`noise-floor-unknown`); the report states the measured Δ only, with no direction.',
      '',
      'How to supply one: `--noise-floor-pct N` pins a previously measured floor, or `--noise <base> <cand>` measures it from two baseline runs.',
    )
    return lines
  }
  lines.push(
    `half-width ±${rawPercent(noise.pct)} · interval [${percent(noise.band.low)}, ${percent(noise.band.high)}] · method \`${noise.method}\` · pairs ${noise.pairs} · task samples ${noise.samples}${noise.medianAbsPct === null ? '' : ` · median magnitude ${rawPercent(noise.medianAbsPct)}`}`,
    '',
    'A Δ is read as a direction only beyond this half-width; inside the band only the interval is reported.',
  )
  if (noise.method === 'provided') lines.push('', 'The floor came from outside (`--noise-floor-pct`), not from a measurement in this run.')
  if (noise.perTask.length > 0) {
    lines.push('', '| task | base | cand | Δ% | pairs |', '| --- | --- | --- | --- | --- |')
    for (const entry of noise.perTask) lines.push(`| ${entry.id} | ${number(entry.base)} | ${number(entry.cand)} | ${percent(entry.pct)} | ${entry.pairs} |`)
  }
  return lines
}

/**
 * The token attribution: how the TOTAL delta splits into the per-request fixed cost,
 * the extra steps, and what neither explains. Diagnostic only — it never fails a run.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function attributionSection(comparison) {
  const overhead = comparison.overhead
  const lines = ['## Token attribution (diagnostic, not a verdict)', '']
  if (!overhead.comparable) {
    lines.push('Skipped: at least one side has no prompt capture (`metrics.prompt`), so the Δ cannot be split into fixed overhead / extra steps / residual.')
    return lines
  }
  lines.push(
    `Attributable tasks ${overhead.comparableTasks}/${overhead.tasks} (the first-step prompt is the only request without history, so fixed overhead is read from it).`,
    '',
    `Attribution covers all ${overhead.tasks} tasks with prompt capture (including pairs outside the cost statistics), so its total can differ from the paired token Δ by the excluded tasks' share.`,
    '',
    '| item | tokens Δ | reading |',
    '| --- | --- | --- |',
    `| fixed overhead per request | ${signed(overhead.fixedOverheadTokens)} | first-step prompt Δ × cand steps: tool schema / prompt strategy |`,
    `| extra steps | ${signed(overhead.extraStepsTokens)} | Δ steps × base first-step prompt: model behaviour |`,
    `| residual | ${signed(overhead.residualTokens)} | context growth / tool returns — whatever the first two terms leave unexplained |`,
    `| output | ${signed(overhead.outputDelta)} | model output |`,
    `| total (prompt + output) | ${signed(overhead.totalDelta)} | same sign and magnitude as the paired token Δ (the gap is the excluded tasks) |`,
  )
  const rows = comparison.tasks.filter((task) => task.overhead?.comparable === true)
  if (rows.length > 0) {
    lines.push('', '### Per-task attribution', '', '| task | fixed overhead Δ | extra steps Δ | residual Δ | output Δ | total Δ |', '| --- | --- | --- | --- | --- | --- |')
    for (const task of rows) {
      const entry = task.overhead
      lines.push(`| ${task.id} | ${signed(entry.fixedOverheadTokens)} | ${signed(entry.extraStepsTokens)} | ${signed(entry.residualTokens)} | ${signed(entry.outputDelta)} | ${signed(entry.totalDelta)} |`)
    }
  }
  return lines
}

/**
 * #183's per-task bucket detail: the three usage buckets behind each task's total.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function bucketSection(comparison) {
  const useMin = comparison.aggregate === 'min'
  const keys = { input: useMin ? 'inputMin' : 'inputMedian', output: useMin ? 'outputMin' : 'outputMedian', cacheRead: useMin ? 'cacheReadMin' : 'cacheReadMedian' }
  const cell = (baseValue, candValue) => `${number(baseValue)} → ${number(candValue)} (${percent(percentChange(baseValue, candValue))})`
  const lines = [
    `## Per-task bucket detail (${comparison.aggregate})`,
    '',
    'Each cell is the paired-sample statistic for that side; the TOTAL row sums the pairs, a different basis from "sum of per-task statistics" (they differ when repeat counts differ, and only the per-task table drives the verdict).',
    '',
    '| task | input base→cand (Δ%) | output base→cand (Δ%) | cache read base→cand (Δ%) |',
    '| --- | --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    lines.push(`| ${task.id} | ${cell(task.base[keys.input], task.cand[keys.input])} | ${cell(task.base[keys.output], task.cand[keys.output])} | ${cell(task.base[keys.cacheRead], task.cand[keys.cacheRead])} |`)
  }
  const buckets = comparison.totals.buckets
  if (buckets.comparable) {
    lines.push(`| **TOTAL** | ${cell(buckets.input.base, buckets.input.cand)} | ${cell(buckets.output.base, buckets.output.cand)} | ${cell(buckets.cacheRead.base, buckets.cacheRead.cand)} |`)
  }
  return lines
}

/**
 * The usage split: how the TOTAL delta divides between uncached input, output and
 * cache reads, with each bucket's share of the delta. The gate judges the total.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function usageSplitSection(comparison) {
  const buckets = comparison.totals.buckets
  const lines = [`## usage split (TOTAL, ${comparison.aggregate})`, '']
  if (!buckets.comparable) {
    lines.push('Skipped: at least one side lost `step_end.usage`, so per-bucket Δs would present a lower bound as a measurement.')
    return lines
  }
  const row = (label, bucket) => `| ${label} | ${number(bucket.base)} | ${number(bucket.cand)} | ${signed(bucket.delta)} (${percent(percentChange(bucket.base, bucket.cand))}) | ${rawPercent(bucket.sharePct)} |`
  lines.push(
    'The three buckets sum to the total; a Δ in cache read and a Δ in uncached input are two very different bills. This section sums the pairs (a different basis from the per-task table totals), and the verdict still reads only the paired token Δ.',
    '',
    '| bucket | base | cand | Δ (Δ%) | share of Δ |',
    '| --- | --- | --- | --- | --- |',
    row('uncached input', buckets.input),
    row('output', buckets.output),
    row('cache read', buckets.cacheRead),
    row('**TOTAL**', buckets.grandTotal),
  )
  return lines
}

/**
 * The behaviour behind the token delta: steps and tool calls, per task and summed.
 * The extra-steps term in token attribution is this table's Δ steps at the baseline's prompt
 * size, so a cost move can be read against the behaviour that produced it. Neither
 * count can change the gate.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function stepsSection(comparison) {
  const useMin = comparison.aggregate === 'min'
  const keys = { steps: useMin ? 'stepsMin' : 'stepsMedian', toolCalls: useMin ? 'toolCallsMin' : 'toolCallsMedian' }
  const cell = (baseValue, candValue, pct) => `${count(baseValue)} → ${count(candValue)} (${percent(pct)})`
  const lines = [
    `## steps and tool calls (${comparison.aggregate})`,
    '',
    'Each cell is the statistic over all repeats on that side; the TOTAL row sums the per-task statistics. Both numbers only explain where the token Δ came from; neither takes part in the verdict.',
    '',
    '| task | steps base→cand (Δ%) | tool calls base→cand (Δ%) |',
    '| --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    lines.push(`| ${task.id} | ${cell(task.base[keys.steps], task.cand[keys.steps], task.delta.stepsPct)} | ${cell(task.base[keys.toolCalls], task.cand[keys.toolCalls], task.delta.toolCallsPct)} |`)
  }
  const totals = comparison.totals
  lines.push(`| **TOTAL** | ${cell(totals.baseSteps, totals.candSteps, percentChange(totals.baseSteps, totals.candSteps))} | ${cell(totals.baseToolCalls, totals.candToolCalls, percentChange(totals.baseToolCalls, totals.candToolCalls))} |`)
  return lines
}

/**
 * Tool adoption, summed over every repeat on each side: a tool called once and never
 * again is still evidence it was published and reached for, and a built-in the
 * candidate kept reaching for is the number this table exists to surface.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function toolSection(comparison) {
  const totals = new Map()
  for (const task of comparison.tasks) {
    for (const side of ['base', 'cand']) {
      for (const [name, count] of Object.entries(task[side].toolCallsByName ?? {})) {
        const entry = totals.get(name) ?? { base: 0, cand: 0 }
        entry[side] += count
        totals.set(name, entry)
      }
    }
  }
  const lines = ['## Tool calls (per-side overlap counts)', '']
  if (totals.size === 0) {
    lines.push('Skipped: neither side recorded `toolCallsByName`.')
    return lines
  }
  const own = (name) => name.startsWith('ops')
  const rows = [...totals.entries()].sort((left, right) => (Number(own(right[0])) - Number(own(left[0]))) || (right[1].cand - left[1].cand) || left[0].localeCompare(right[0]))
  lines.push(
    'Red numbers in the cand column: the tool does not start with `ops`, yet the candidate side called it — a call the plugin did not cover. The base column is never painted (the baseline only has built-ins), and a count of zero is not painted either (that is not using it, not still using it).',
    '',
    '| tool | base | cand |',
    '| --- | --- | --- |',
  )
  for (const [name, counts] of rows) {
    const cell = counts.cand > 0 && !own(name) ? alarm(number(counts.cand)) : number(counts.cand)
    lines.push(`| ${name} | ${number(counts.base)} | ${cell} |`)
  }
  return lines
}

/**
 * Every warning the core recorded (model mismatch, incomplete usage, one-sided
 * tasks, pairing leftovers) — nothing measured is allowed to disappear quietly.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function warningSection(comparison) {
  if (comparison.warnings.length === 0) return ['## Warnings', '', 'No warnings.']
  return ['## Warnings', '', ...comparison.warnings.map((warning) => `- ${paintPercents(warning)}`)]
}

/**
 * Render the comparison as `report.md`.
 *
 * Pure: same comparison and sources in, byte-identical text out. No timestamps are
 * written, so the report is reproducible and diffable.
 * @param {object} comparison - the structure from `compareSummaries`.
 * @param {{base?: object, cand?: object}} [sources] - the two resolved sides.
 * @returns {string} the report text (no trailing newline).
 */
export function renderReport(comparison, sources = {}) {
  const lines = [
    REPORT_TITLE,
    '',
    ...taskSection(comparison),
    '',
    ...excludedSection(comparison),
    '',
    ...noiseSection(comparison),
    '',
    ...attributionSection(comparison),
    '',
    ...bucketSection(comparison),
    '',
    ...usageSplitSection(comparison),
    '',
    ...stepsSection(comparison),
    '',
    ...toolSection(comparison),
    '',
    ...warningSection(comparison),
    '',
    '## Evidence',
    '',
    `- base:${sources.base?.file ?? '?'}(spec \`${sources.base?.spec ?? '?'}\`,${sources.base?.kind ?? '?'})`,
    `- cand:${sources.cand?.file ?? '?'}(spec \`${sources.cand?.spec ?? '?'}\`,${sources.cand?.kind ?? '?'})`,
    `- document: format \`${comparison.format}\` · aggregate \`${comparison.aggregate}\` · tolerance ${rawPercent(comparison.tolerancePct)}`,
    '',
    `Time fields are evidence only: the cost basis of this report is paired tokens, and the comparison does not read duration into the verdict (${COMPARE_FORMAT} carries no time statistics).`,
    '',
    ...verdictSection(comparison),
  ]
  return lines.join('\n')
}

/**
 * Where the rendered artifact goes.
 * @param {Options} options - the parsed options.
 * @param {{dir: string}} cand - the resolved candidate side.
 * @returns {string|null} the absolute path, or null to write no file.
 */
function reportPath(options, cand) {
  if (options.out === '-') return null
  if (options.out !== null) return path.resolve(options.out)
  if (options.json) return null
  return path.join(cand.dir, 'report.md')
}

/**
 * The comparator's main.
 *
 * Everything that decides is in `compare-core.mjs`; this resolves, renders, writes
 * and maps the gate to an exit code. A cost gate that could not run (no noise floor,
 * incomplete usage, no both-passed pair) abstains — it does not fail the run.
 * @param {string[]} argv - the arguments after the script name.
 * @param {{out?: Function, err?: Function}} [io] - output sinks; defaults to the console.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    err(USAGE)
    err(`compare: ${String(error?.message ?? error)}`)
    return EXIT.usage
  }
  if (options.help) {
    out(USAGE)
    return EXIT.ok
  }

  let base
  let cand
  let noise = null
  try {
    base = resolveSide(options.base, options)
    cand = resolveSide(options.cand, options)
    if (options.noise !== null) {
      noise = { base: resolveSide(options.noise[0], options).doc, cand: resolveSide(options.noise[1], options).doc }
    }
  } catch (error) {
    err(`compare: ${String(error?.message ?? error)}`)
    return EXIT.usage
  }

  const comparison = compareSummaries(base.doc, cand.doc, {
    aggregate: options.aggregate,
    tolerancePct: options.tolerancePct,
    failOn: options.failOn,
    regressionScope: options.regressionScope,
    noiseFloorPct: options.noiseFloorPct ?? undefined,
    noise: noise ?? undefined,
  })
  const sources = {
    base: { spec: options.base, file: base.file, kind: base.kind },
    cand: { spec: options.cand, file: cand.file, kind: cand.kind },
  }
  const payload = options.json
    ? `${JSON.stringify(comparison, null, 2)}\n`
    : `${renderReport(comparison, sources)}\n`
  out(payload)

  const target = reportPath(options, cand)
  if (target !== null) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, payload, 'utf8')
    } catch (error) {
      err(`compare: could not write ${target} (${String(error?.message ?? error)})`)
      return EXIT.failure
    }
    err(`compare: wrote ${target}`)
  }

  if (comparison.gate.fail) {
    err(`compare: GATE FAILED (${comparison.gate.failOn}) — ${comparison.gate.reasons.join('; ')}`)
    return EXIT.failure
  }
  if (options.failOn !== 'none') {
    if (!comparison.gate.tokensComparable) err('compare: cost gate did not run (usage incomplete on at least one side); only the pass-drop gate ran.')
    else if (!comparison.gate.costComparable) err(`compare: cost gate did not run (no pair passed on both sides; ${comparison.gate.excludedPairs} pair(s) excluded); only the pass-drop gate ran.`)
    else if (!comparison.noiseFloor.comparable) err('compare: noise floor unknown ⇒ cost direction withheld (noise-floor-unknown); supply one with --noise-floor-pct or --noise.')
  }
  return EXIT.ok
}

// Only when executed, not when the suite imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
