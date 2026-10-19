/** Current user-facing docs mirror catalogue facts; keep the current surface from drifting again. */
import fs from 'node:fs'
import path from 'node:path'
import { CAPABILITIES, FILE_TOOLS } from '../lib/capabilities/registry.js'
import { DISCOVERY_TERMS } from '../lib/capabilities/discovery.js'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const read = name => fs.readFileSync(path.join(PACKAGE_ROOT, name), 'utf8')
const docs = fs.readdirSync(path.join(PACKAGE_ROOT, 'docs'))
  .filter(name => name.endsWith('.md') && name !== 'CHANGELOG.md')
  .map(name => 'docs/' + name)
const CURRENT_DOCS = [...docs, 'README.md', 'README.en.md', 'README.zh.md']
// Derived from the catalogue, never hand-copied: a renamed or added tool must move these numbers.
const PTC_MEMBERS = CAPABILITIES.filter(entry => 'parameters' in entry && entry.presentations.includes('ptc')).length
const DISCOVERABLE = Object.keys(DISCOVERY_TERMS).sort()
const STALE = /ops_(?:read_many|edit_many|table_read|doc_read|pdf_read|sdk|discover)\b|\b(?:read_many|edit_many|table_read|doc_read|pdf_read)\b/u

await test('current docs never spell a pre-rename tool name, prefixed or bare', () => {
  for (const file of CURRENT_DOCS) {
    const match = read(file).match(STALE)
    assert.equal(match, null, `${file} still mentions ${String(match?.[0])}`)
  }
})

await test('the catalogue counts in the current docs match the registry', () => {
  assert.match(read('docs/component-reference.md'), new RegExp(`has ${CAPABILITIES.length} entries`))
  assert.match(read('docs/component-reference.md'), new RegExp(`${PTC_MEMBERS} APIs: ${FILE_TOOLS.length} file/document tools`))
  assert.match(read('docs/组件参考.md'), new RegExp(`有 ${CAPABILITIES.length} 项`))
  assert.match(read('docs/组件参考.md'), new RegExp(`${PTC_MEMBERS} 个 API：${FILE_TOOLS.length} 个文件/文档工具`))
  assert.match(read('docs/ptc-sdk-loading.md'), new RegExp(`${PTC_MEMBERS} APIs`))
  assert.match(read('docs/PTC按需加载.md'), new RegExp(`${PTC_MEMBERS} 个 API`))
  assert.match(read('README.md'), new RegExp(`${FILE_TOOLS.length} 个文件/文档工具`))
  assert.match(read('README.zh.md'), new RegExp(`${FILE_TOOLS.length} 个文件/文档工具`))
  assert.match(read('README.en.md'), new RegExp(`${FILE_TOOLS.length} file/document tools`))
})

await test('the current token and byte budget matches the measured gate', () => {
  assert.match(read('docs/discovery.md'), /242 tokens \/ 1101 bytes/u)
  assert.match(read('docs/工具发现.md'), /242 tokens \/ 1101 字节/u)
  assert.match(read('docs/benchmark-gates.md'), /242 tokens \/ 1,101 bytes/u)
  assert.doesNotMatch(read('docs/discovery.md'), /241 tokens/u)
})

await test('the discovery allowedTools example is exactly the discoverable catalogue', () => {
  for (const file of ['docs/discovery.md', 'docs/工具发现.md']) {
    const line = read(file).split('\n').find(entry => entry.includes('allowedTools:'))
    assert.ok(line, `${file} has no allowedTools example`)
    const body = line.slice(line.indexOf('allowedTools:') + 'allowedTools:'.length)
    const names = body.replace(/^[^[]*\[/u, '').replace(/\].*$/u, '').split(',').map(name => name.trim()).filter(Boolean)
    assert.deepEqual([...new Set(names)].sort(), DISCOVERABLE, `${file} diverges from DISCOVERY_TERMS`)
  }
})

report('docs-facts')
