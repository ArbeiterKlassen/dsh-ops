/** Registry migration preserves the complete previously published host definitions. */
import { createHash } from 'node:crypto'
import { CAPABILITIES, FILE_CAPABILITIES, PTC_CAPABILITIES, SHELL_CAPABILITIES, capability, capabilitiesFor } from '../lib/capabilities/registry.js'
import { FILE_TOOLS, FILE_MUTATIONS, IN_PROCESS_TOOLS, BASH_TOOL, publicToolName } from '../lib/policy.js'
import { definition as fileDefinition, PARAMETERS as fileParameters, DESCRIPTIONS as fileDescriptions } from '../lib/file/contract.js'
import { definition as ptcDefinition, PTC_TOOLS, PARAMETERS as ptcParameters, DESCRIPTIONS as ptcDescriptions } from '../lib/ptc/contract.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { BASH_TOOL_NAME } from '../lib/shells/constants.js'
import { assert, test, report } from './lib/harness.mjs'

await test('the catalogue covers every owned file, PTC and shell tool exactly once', () => {
  assert.equal(CAPABILITIES.length, 16)
  assert.equal(new Set(CAPABILITIES.map(item => item.rawName)).size, CAPABILITIES.length)
  assert.deepEqual(FILE_TOOLS, ['inspect_local_file', 'grep', 'glob', 'replace', 'write_file', 'edit_file', 'diff', 'stat', 'copy', 'move', 'remove', 'read_many', 'edit_many'])
  assert.deepEqual(FILE_MUTATIONS, ['replace', 'write_file', 'edit_file', 'copy', 'move', 'remove', 'edit_many'])
  assert.deepEqual(PTC_TOOLS, ['batch', 'result'])
  assert.deepEqual(IN_PROCESS_TOOLS, ['bash'])
  assert.equal(BASH_TOOL_NAME, BASH_TOOL)
  for (const [entries, parameters, descriptions] of [[FILE_CAPABILITIES, fileParameters, fileDescriptions], [PTC_CAPABILITIES, ptcParameters, ptcDescriptions]]) {
    assert.deepEqual(entries.map(item => item.rawName).sort(), Object.keys(parameters).sort())
    assert.deepEqual(Object.keys(parameters).sort(), Object.keys(descriptions).sort())
    for (const entry of entries) {
      assert.equal(capability(entry.rawName), entry)
      assert.equal(entry.parameters, parameters[entry.rawName])
      assert.equal(entry.description, descriptions[entry.rawName])
    }
  }
  for (const component of ['file', 'ptc', 'shell']) assert.deepEqual(capabilitiesFor(component), CAPABILITIES.filter(item => item.component === component))
  for (const name of ['unknown', 'toString', '__proto__']) assert.equal(capability(name), undefined)
})

await test('metadata preserves current mode availability and conservative concurrency', () => {
  for (const entry of [...FILE_CAPABILITIES, ...SHELL_CAPABILITIES]) assert.deepEqual(entry.presentations, ['native', 'ptc', 'both'])
  for (const entry of PTC_CAPABILITIES) assert.deepEqual(entry.presentations, ['ptc'])
  for (const entry of CAPABILITIES) {
    assert.equal(entry.availability, 'resident')
    assert.equal(entry.concurrencySafe, entry.component === 'file' && !entry.mutates)
  }
})

const snapshot = (names, definition) => names.map(name => {
  const d = definition(name, async () => null)
  return { name: d.name, description: d.description, parameters: d.parameters, output: d.output.schema,
    concurrent: d.isConcurrencySafe?.({}) ?? false, timeoutMs: d.timeoutMs ?? null }
})
await test('unchanged file definitions and PTC definitions retain their original serialized contracts', () => {
  // Captured before this migration, covering every argument/output contract and published description.
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.equal(hash(snapshot(FILE_TOOLS.filter(name => !['glob', 'grep', 'read_many', 'edit_many'].includes(name)), fileDefinition)), 'f32e33306b4052fdb3d19a11e0fe9d65c255a87d2d485de08a9d7b1275e958fc')
  assert.equal(hash(snapshot(PTC_TOOLS, ptcDefinition)), '74e6a50db799da1aa80c745e18c67be577426cc41441f9d0f8c87673c04f3c43')
})

await test('native registration consumes the catalogue while execute values stay unchanged', async () => {
  const registered = [], disposed = []
  const runtime = new NativeFileTools({ ctx: { tools: { register(definition) {
    registered.push(definition); return () => disposed.push(definition.name)
  } } }, config: { workerPath: 'fixture-worker' } })
  assert.deepEqual(await runtime.start(), FILE_CAPABILITIES.map(item => publicToolName(item.rawName)))
  assert.deepEqual(registered.map(item => item.name), FILE_TOOLS.map(publicToolName))
  const canonical = { status: 'completed', items: [{ path: '/file', line: 1, text: 'text' }], complete: false }
  for (const [names, definition] of [[FILE_TOOLS, fileDefinition], [PTC_TOOLS, ptcDefinition]]) {
    for (const name of names) {
      const tool = definition(name, async () => canonical)
      assert.equal(await tool.execute({}, {}), canonical)
      assert.equal(canonical.items[0].path, '/file')
      if (names === PTC_TOOLS) assert.deepEqual(JSON.parse(tool.output.render({}, canonical)[0].text), canonical)
      else assert.equal(typeof tool.output.render({}, canonical)[0].text, 'string')
    }
  }
  await runtime.stop()
  assert.deepEqual(disposed, registered.map(item => item.name))
})
report('capabilities')
