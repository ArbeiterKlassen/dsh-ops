import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { resolveHidingConfig } from '../lib/config.js'
import { isOfficialTool, OFFICIAL_TOOL_NAMES, OFFICIAL_REPLACEMENTS, platformSurface } from '../lib/official-tool-catalog.js'
import { assert, PACKAGE_ROOT, report, test } from './lib/harness.mjs'
import { officialToolHidingMountChecks } from './lib/official-tool-hiding.mjs'

await test('strict hiding config is independent, rejects downgrade/unknown keys and copies aliases', () => {
  assert.deepEqual(resolveHidingConfig(), { strict: true, additionalOfficialTools: [] })
  for (const config of [null, [], false, { strict: false }, { strict: 'true' }, { required: true },
    { additionalOfficialTools: 'subagent' }, { additionalOfficialTools: [''] }, { additionalOfficialTools: ['ops_read'] }]) {
    assert.throws(() => resolveHidingConfig(config))
  }
  const raw = { additionalOfficialTools: ['custom_delegation', 'custom_delegation'] }
  const result = resolveHidingConfig(raw)
  raw.additionalOfficialTools.push('another')
  assert.deepEqual(result.additionalOfficialTools, ['custom_delegation'])
})
await test('strict hiding is disabled opt-in and the pinned platform surface is exact', () => {
  const document = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  const rows = document.flatMap(item => item.insert)
  const hiding = rows.find(row => row.name === 'dsh-ops/hide-official')
  // Registered but never enabled by default: enabling the row is an operator
  // decision, and a strict component that defaults on would refuse assembly on
  // every install that lacks the complete native surface.
  assert.equal(hiding.disabled, true)
  assert.deepEqual(resolveHidingConfig(hiding.config), { strict: true, additionalOfficialTools: [] })
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(platformSurface(platform), { retainedCommand: platform === 'win32' ? 'pwsh' : 'bash', shellDefaultEnabled: platform === 'win32' })
  }
  assert.throws(() => platformSurface('freebsd'), /Unsupported/)
})
await test('catalog covers the pinned official categories without guessing third-party or OPS equivalence', () => {
  assert.equal(new Set(OFFICIAL_TOOL_NAMES).size, OFFICIAL_TOOL_NAMES.length)
  for (const name of ['run_code', 'bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'str_replace_editor',
    'exit_plan_mode', 'subagent', 'subagent_fork', 'ask_user_question', 'web_search', 'web_fetch', 'terminal_send', 'plugin_manager',
    'schedule_create', 'list_mcp_resources', 'session_trace', 'lsp', 'workflow', 'team_task_list', 'stagehand_tabs', 'cua_driver_native__dynamic']) {
    assert.equal(isOfficialTool(name), true, name)
  }
  for (const name of ['foreign', 'mcp__server__tool', 'ops_read', 'ops_glob']) assert.equal(isOfficialTool(name), false)
  assert.equal(isOfficialTool('custom_alias', ['custom_alias']), true)
  assert.deepEqual(Object.keys(OFFICIAL_REPLACEMENTS).sort(), ['glob', 'grep', 'read'])
})
await officialToolHidingMountChecks()
report('official-tool-hiding')
