import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

export function tokenEstimate(bytes) {
  return Math.ceil(bytes / 4)
}

export function surfaceAccounting({ schemas = [], sections = [] } = {}) {
  const cleanSchemas = schemas.map(schema => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    output: schema.output?.schema ?? schema.output,
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const cleanSections = sections.map(section => ({ name: section.name, text: String(section.text ?? '') }))
  const schemaBytes = jsonBytes(stable(cleanSchemas))
  const promptBytes = jsonBytes(stable(cleanSections))
  return {
    schemaCount: cleanSchemas.length,
    schemaBytes,
    schemaTokensEstimate: tokenEstimate(schemaBytes),
    schemaSha256: createHash('sha256').update(JSON.stringify(stable(cleanSchemas))).digest('hex'),
    promptSectionCount: cleanSections.length,
    promptBytes,
    promptTokensEstimate: tokenEstimate(promptBytes),
    promptSha256: createHash('sha256').update(JSON.stringify(stable(cleanSections))).digest('hex'),
  }
}

export function measurementSummary(samples) {
  const values = samples.map(sample => sample.ms).sort((a, b) => a - b)
  if (!values.length) return { count: 0 }
  const percentile = fraction => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))]
  return {
    count: values.length,
    minMs: values[0],
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: values.at(-1),
    bytes: samples.reduce((sum, sample) => sum + (sample.bytes ?? 0), 0),
  }
}

export async function measure(label, count, fn) {
  const samples = []
  for (let index = 0; index < count; index += 1) {
    const started = process.hrtime.bigint()
    const result = await fn(index)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    samples.push({ sample: index + 1, ms: Number(ms.toFixed(3)), ...(result ?? {}) })
  }
  return { label, samples, summary: measurementSummary(samples) }
}

export function markdownReport(report) {
  const lines = [
    '# dsh-ops local benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Commit: ${report.environment.gitCommit ?? 'unknown'}`,
    `Platform: ${report.environment.platform}-${report.environment.arch}, Node ${report.environment.node}`, 
    '',
    '> Local-only harness. It is intentionally not part of `npm run verify` and refuses GitHub Actions.',
    '',
    '## Summary',
    '',
    '| Scenario | Surface | Status | Measurements | Notes |',
    '| --- | --- | --- | ---: | --- |',
  ]
  for (const scenario of report.scenarios) {
    const note = scenario.reason ?? scenario.measurements?.map(item => `${item.label}: ${item.summary?.medianMs ?? '-'} ms median`).join('; ') ?? ''
    lines.push(`| ${scenario.id} | ${scenario.surface} | ${scenario.status} | ${scenario.measurements?.length ?? 0} | ${String(note).replaceAll('|', '\\|')} |`)
  }
  lines.push('', '## Schema and token accounting', '', '| Surface | Schemas | Schema bytes / tokens | Prompt bytes / tokens |', '| --- | ---: | ---: | ---: |')
  for (const item of report.schemaAccounting ?? []) {
    lines.push(`| ${item.surface} | ${item.schemaCount} | ${item.schemaBytes} / ${item.schemaTokensEstimate} | ${item.promptBytes} / ${item.promptTokensEstimate} |`)
  }
  lines.push('', '## Limitations', '')
  for (const limitation of report.limitations ?? []) lines.push(`- ${limitation}`)
  lines.push('')
  return lines.join('\n')
}

export function writeReports(report, { jsonFile, markdownFile }) {
  mkdirSync(path.dirname(jsonFile), { recursive: true })
  mkdirSync(path.dirname(markdownFile), { recursive: true })
  writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(markdownFile, markdownReport(report))
  return { jsonFile, markdownFile }
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
