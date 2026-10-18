import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { resolveHidingConfig } from '../lib/config.js'
import { isOfficialTool, OFFICIAL_TOOL_NAMES, OFFICIAL_REPLACEMENTS, platformSurface } from '../lib/official-tool-catalog.js'
import { classifyOfficialSurface, isHideable, surfaceWarning, TAKEOVER_SCOPE, takeoverFace } from '../lib/official-tool-hiding.js'
import { assert, PACKAGE_ROOT, report, test } from './lib/harness.mjs'
import { officialToolHidingMountChecks, STOCK_UNSUPPORTED_48 } from './lib/official-tool-hiding.mjs'

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
  // decision, and a component that hid host capabilities by default would
  // change every install's surface without one.
  assert.equal(hiding.disabled, true)
  assert.deepEqual(resolveHidingConfig(hiding.config), { strict: true, additionalOfficialTools: [] })
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(platformSurface(platform), { retainedCommand: platform === 'win32' ? 'pwsh' : 'bash', shellDefaultEnabled: true })
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
await test('the takeover scope is exactly shell/file/ptc, and hiding needs a reviewed replacement', () => {
  assert.deepEqual(Object.keys(TAKEOVER_SCOPE), ['shell', 'file', 'ptc'])
  for (const [tool, face] of [['bash', 'shell'], ['pwsh', 'shell'], ['read', 'file'], ['write', 'file'],
    ['str_replace_editor', 'file'], ['run_code', 'ptc']]) assert.equal(takeoverFace(tool), face, tool)
  // Host capabilities the component was never meant to replace are out of scope.
  assert.equal(takeoverFace('subagent'), undefined)
  assert.equal(takeoverFace('terminal_send'), undefined)
  assert.equal(takeoverFace('read_image'), undefined)
  assert.equal(takeoverFace('web_search'), undefined)
  for (const tool of ['read', 'glob', 'grep']) assert.equal(isHideable(tool, 'win32'), true, tool)
  // In scope without a reviewed replacement: a hide candidate is not claimed.
  for (const tool of ['write', 'edit', 'str_replace_editor', 'run_code']) assert.equal(isHideable(tool, 'linux'), false, tool)
  // The platform's retained host shell is never hidden, on either side.
  assert.equal(isHideable('pwsh', 'win32'), false)
  assert.equal(isHideable('bash', 'linux'), false)
  assert.equal(isHideable('subagent', 'win32'), false)
  // An alias cannot extend hiding outside the scope, even when it is official.
  assert.equal(isHideable('custom_delegate', 'linux'), false)
})
await test('the reported 48-tool surface classifies without a fatal condition and keeps every out-of-scope tool', () => {
  // The #207 stock surface: 48 unsupported tools plus read/glob/grep (replaced)
  // and pwsh (the Windows retained host shell) — 52 official tools in total.
  const surface = [...STOCK_UNSUPPORTED_48, 'read', 'glob', 'grep', 'pwsh']
  assert.equal(surface.length, 52)
  assert.equal(new Set(surface).size, 52)
  const outOfScope = STOCK_UNSUPPORTED_48.filter(tool => !['edit', 'write'].includes(tool)).sort()
  assert.equal(outOfScope.length, 46)

  const win = classifyOfficialSurface(surface, resolveHidingConfig(), 'win32')
  assert.equal(win.official.length, 52)
  assert.equal(win.retainedCommand, 'pwsh')
  assert.deepEqual(win.hidden, ['glob', 'grep', 'read'])
  assert.deepEqual(win.outOfScope, outOfScope)
  assert.deepEqual(win.inScopeUnsupported, ['edit', 'write'])
  assert.deepEqual(win.explicitUnsupported, [])
  const warning = surfaceWarning(win)
  assert.doesNotMatch(warning, /READINESS_BLOCKED/)
  assert.match(warning, /46 official tools stay visible because they are outside the dsh-ops takeover scope \(shell\/file\/ptc\)/)
  assert.match(warning, /2 in-scope official tools stay visible because no registered OPS equivalent exists: edit, write/)

  // `pwsh` is the retained host shell on Windows, and an in-scope unsupported
  // tool on Linux — never a hide candidate and never fatal on either platform.
  const linux = classifyOfficialSurface(surface, resolveHidingConfig(), 'linux')
  assert.deepEqual(linux.inScopeUnsupported, ['edit', 'pwsh', 'write'])
  assert.equal(linux.outOfScope.length, 46)
  assert.deepEqual(linux.hidden, ['glob', 'grep', 'read'])

  // `additionalOfficialTools` escalates an in-scope tool into fail-closed and
  // is only warned about outside the scope. Classification itself never throws.
  const explicit = classifyOfficialSurface(surface, resolveHidingConfig({ additionalOfficialTools: ['write', 'subagent', 'pwsh'] }), 'win32')
  assert.deepEqual(explicit.explicitUnsupported, ['write'])
  assert.deepEqual(explicit.explicitOutOfScope, ['subagent'])
  assert.equal(explicit.inScopeUnsupported.includes('pwsh'), false)
  assert.match(surfaceWarning(explicit), /explicit additionalOfficialTools request for subagent is ignored/)
})
await officialToolHidingMountChecks()
report('official-tool-hiding')
