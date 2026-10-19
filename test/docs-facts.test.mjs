/** Current user-facing docs mirror catalogue facts; keep the current surface from drifting again. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const read = name => fs.readFileSync(path.join(PACKAGE_ROOT, name), 'utf8')
const CURRENT_DOCS = [
  'README.md', 'README.en.md', 'README.zh.md',
  'docs/usage.md', 'docs/使用指南.md',
  'docs/discovery.md', 'docs/工具发现.md',
  'docs/component-reference.md', 'docs/组件参考.md',
  'docs/configuration-reference.md', 'docs/配置参考.md',
  'docs/ptc-sdk-loading.md', 'docs/PTC按需加载.md',
]

await test('current docs never spell a pre-rename public tool name', () => {
  const stale = /ops_(?:read_many|edit_many|table_read|doc_read|pdf_read|sdk|discover)\b/u
  for (const file of CURRENT_DOCS) {
    const match = read(file).match(stale)
    assert.equal(match, null, `${file} still mentions the pre-rename public name ${String(match?.[0])}`)
  }
})

await test('the catalogue counts in the current docs match the registry', () => {
  assert.match(read('docs/component-reference.md'), /has 20 entries/u)
  assert.doesNotMatch(read('docs/component-reference.md'), /has 21 entries/u)
  assert.match(read('docs/组件参考.md'), /有 20 项/u)
  assert.doesNotMatch(read('docs/组件参考.md'), /有 21 项/u)
  assert.match(read('docs/ptc-sdk-loading.md'), /18 APIs/u)
  assert.doesNotMatch(read('docs/ptc-sdk-loading.md'), /19 APIs/u)
  assert.match(read('docs/PTC按需加载.md'), /18 个 API/u)
  assert.doesNotMatch(read('docs/PTC按需加载.md'), /19 个 API/u)
})

await test('the current token budget statement matches the measured gate', () => {
  assert.match(read('docs/discovery.md'), /242 tokens/u)
  assert.doesNotMatch(read('docs/discovery.md'), /241 tokens/u)
  assert.match(read('docs/工具发现.md'), /242 tokens/u)
  assert.doesNotMatch(read('docs/工具发现.md'), /241 tokens/u)
  assert.match(read('docs/benchmark-gates.md'), /242 tokens/u)
})

await test('the discovery allowedTools example lists each name exactly once', () => {
  for (const file of ['docs/discovery.md', 'docs/工具发现.md']) {
    const line = read(file).split('\n').find(entry => entry.includes('allowedTools:'))
    assert.ok(line, `${file} has no allowedTools example`)
    const names = [...line.matchAll(/[a-z_]+/gu)].map(match => match[0]).filter(name => name !== 'allowedTools')
    assert.equal(new Set(names).size, names.length, `${file} repeats a name in its allowedTools example`)
  }
})

report('docs-facts')