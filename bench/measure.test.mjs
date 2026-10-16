import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measurementSummary, markdownReport, surfaceAccounting, tokenEstimate } from './lib/measure.mjs'

test('surface accounting is stable and records schema/prompt hashes', () => {
  const one = surfaceAccounting({
    schemas: [{ name: 'ops_glob', description: 'glob', parameters: { type: 'object' } }],
    sections: [{ name: 'tools', text: 'Use ops_glob.' }],
  })
  const two = surfaceAccounting({
    schemas: [{ parameters: { type: 'object' }, description: 'glob', name: 'ops_glob' }],
    sections: [{ text: 'Use ops_glob.', name: 'tools' }],
  })
  assert.deepEqual(one, two)
  assert.equal(one.schemaCount, 1)
  assert.match(one.schemaSha256, /^[a-f0-9]{64}$/)
  assert.match(one.promptSha256, /^[a-f0-9]{64}$/)
  assert.equal(one.schemaTokensEstimate, tokenEstimate(one.schemaBytes))
})

test('measurement summary computes ordered percentiles and output bytes', () => {
  const summary = measurementSummary([{ ms: 30, bytes: 3 }, { ms: 10, bytes: 1 }, { ms: 20, bytes: 2 }])
  assert.deepEqual(summary, { count: 3, minMs: 10, meanMs: 20, medianMs: 20, p95Ms: 20, maxMs: 30, bytes: 6 })
})

test('markdown report shows skipped capability reasons', () => {
  const text = markdownReport({
    generatedAt: 'now', environment: { platform: 'linux', arch: 'x64', node: 'v22', gitCommit: 'abc' },
    scenarios: [{ id: 'host', surface: 'host', status: 'skipped', reason: 'API unavailable' }],
    schemaAccounting: [], limitations: [],
  })
  assert.match(text, /\| host \| host \| skipped /)
  assert.match(text, /API unavailable/)
})
