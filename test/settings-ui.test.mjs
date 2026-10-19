/** Browser interactions exercise real DOM events; the first fixture writes through the host. */
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { assert, test, report } from './lib/harness.mjs'
import { profileFixture } from './lib/settings-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { Config } from '../lib/components/hide-official/index.js'
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) globalThis[name] = dom.window[name]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReplacementForm, DiscoveryForm } = await import('../lib/client/selections.js')
const { ShellForm } = await import('../lib/client/shell-form.js')
const { RuntimePanel } = await import('../lib/client/runtime-panel.js')
const { en } = await import('../lib/client/locales.js')
const t = key => en[key]
const ready = (value, revision = 'v1') => ({ status: 'ready', mode: 'host', writable: true, value, base: {}, user: {}, revision })
const snapshot = { platform: 'win32', managed: [{ version: 'fixture', directory: 'C:\\managed', owned: true }], git: ['C:\\Git\\bin\\bash.exe'], powerShell: { supported: true, guidance: 'Restart DSH.' } }
const ok = value => ({ ok: true, value })
const defaultApi = () => ({ snapshot: async () => ok(snapshot), select: async () => ok({ bashPath: snapshot.git[0], restriction: 'Partial enforcement.' }), plan: async action => ok({ id: 'plan-id', action, available: true, details: ['Review installation first.'] }), execute: async () => ok({ status: 'completed', effectState: 'applied', message: 'Completed.' }) })
async function mount(component, props) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = next => root.render(h(component, { view: 'page', t, ...next }))
  const render = async next => { await act(async () => update(next)) }
  await render(props)
  return { container, render, update, close: async () => { await act(async () => root.unmount()); container.remove() } }
}
const button = (container, text) => [...container.querySelectorAll('button')].find(node => node.textContent === text)
async function click(node) { assert.ok(node, 'DOM target exists'); await act(async () => node.click()) }
async function input(node, value) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) })
}

await test('replacement DOM saves use host revision, persist and reload; subsequent edits use the new revision', async () => {
  let observed, mounts = 0
  const fixture = await profileFixture('browser-replacements', { Config, apply(_ctx, value) { observed = value; mounts++ } }, { replaceTools: [] })
  let view, pending
  const form = { state: ready(fixture.snapshot().value, fixture.snapshot().revision), mutate(ops, revision) { return pending = (async () => {
    await fixture.mutate(ops, revision); await fixture.ctx.loader.await()
    form.state = ready(fixture.snapshot().value, fixture.snapshot().revision)
    view.update({ form }); return true
  })() } }
  try {
    view = await mount(ReplacementForm, { form })
    const initialMounts = mounts
    await click(view.container.querySelector('input'))
    await click(button(view.container, en.save))
    await act(async () => pending)
    assert.deepEqual(observed.replaceTools, ['read'])
    assert.equal(mounts, initialMounts + 1)
    assert.match(fs.readFileSync(fixture.patchPath, 'utf8'), /- read/)
    assert.match(view.container.textContent, /Saved\. The host reloaded/)
    await click(view.container.querySelectorAll('input')[1])
    await click(button(view.container, en.save))
    await act(async () => pending)
    assert.deepEqual(observed.replaceTools, ['read', 'glob'])
    assert.equal(mounts, initialMounts + 2)
  } finally { await view?.close(); await shutdown(fixture.ctx) }
})

await test('dirty drafts retain their revision and refused saves never claim success', async () => {
  const calls = [], form = { state: ready({ replaceTools: [] }), mutate: async (...args) => { calls.push(args); return false } }
  const view = await mount(ReplacementForm, { form })
  try {
    await click(view.container.querySelector('input'))
    form.state = ready({ replaceTools: ['grep'] }, 'v2'); await view.render({ form })
    await click(button(view.container, en.save))
    assert.deepEqual(calls, [[[{ op: 'set', path: ['replaceTools'], value: ['read'] }], 'v1']])
    assert.match(view.container.textContent, /refused/)
    assert.equal(view.container.textContent.includes(en.saved), false)
    await click(button(view.container, en.reset))
    assert.equal(view.container.querySelectorAll('input')[2].checked, true)
    form.mutate = async () => { throw new Error('Profile is read-only') }
    await click(view.container.querySelector('input')); await click(button(view.container, en.save))
    assert.match(view.container.textContent, /Profile is read-only/)
  } finally { await view.close() }
})

await test('discovery controls remove always-loaded entries with their pool and reject invalid limits', async () => {
  const calls = [], form = { state: ready({ allowedTools: ['glob', 'grep'], alwaysLoaded: ['glob'], enabled: true, maxResults: 3 }), mutate: async (...args) => { calls.push(args); return true } }
  const view = await mount(DiscoveryForm, { form })
  try {
    const fields = view.container.querySelectorAll('fieldset')
    const glob = [...fields[0].querySelectorAll('label')].find(node => node.textContent === 'glob').querySelector('input')
    await click(glob)
    const always = [...fields[1].querySelectorAll('label')].find(node => node.textContent === 'glob').querySelector('input')
    assert.equal(always.checked, false); assert.equal(always.disabled, true)
    await input(view.container.querySelector('input[type=number]'), '6')
    assert.equal(button(view.container, en.save).disabled, true)
    assert.match(view.container.querySelector('[role=alert]').textContent, /1 to 5/)
    await input(view.container.querySelector('input[type=number]'), '2')
    await click(button(view.container, en.save))
    assert.deepEqual(calls, [[[{ op: 'set', path: ['enabled'], value: true }, { op: 'set', path: ['maxResults'], value: 2 }, { op: 'set', path: ['allowedTools'], value: ['grep'] }, { op: 'set', path: ['alwaysLoaded'], value: [] }], 'v1']])
  } finally { await view.close() }
})

await test('runtime selection only edits the shell draft; clearing an override uses unset', async () => {
  const calls = [], form = { state: ready({ publishBashTool: true }), mutate: async (...args) => { calls.push(args); return true } }
  const view = await mount(ShellForm, { form, api: defaultApi() })
  try {
    await click(button(view.container, en.git))
    assert.equal(calls.length, 0)
    assert.equal(view.container.querySelector('input[type=text]').value, snapshot.git[0])
    await click(button(view.container, en.save))
    assert.equal(calls[0][0][0].value, snapshot.git[0])
    await input(view.container.querySelector('input[type=text]'), 'temporary')
    await input(view.container.querySelector('input[type=text]'), '')
    await click(button(view.container, en.save))
    assert.deepEqual(calls[1][0][0], { op: 'unset', path: ['bashPath'] })
  } finally { await view.close() }
})

await test('runtime actions require preview plus explicit execution and retain transport failures after refresh', async () => {
  const calls = [], api = defaultApi()
  api.plan = async action => { calls.push(['plan', action]); return ok({ id: 'reviewed-id', action, available: true, details: ['Standard host installation.'] }) }
  api.execute = async id => { calls.push(['execute', id]); return { ok: false, error: { message: 'Shell row became unavailable' } } }
  const view = await mount(RuntimePanel, { api, editable: true, onSelect() {} })
  try {
    await click(button(view.container, en.previewPwsh))
    assert.deepEqual(calls, [['plan', 'upgrade-pwsh']])
    assert.match(view.container.querySelector('[role=region]').textContent, /Standard host installation/)
    await click(button(view.container, en.upgrade))
    assert.deepEqual(calls, [['plan', 'upgrade-pwsh'], ['execute', 'reviewed-id']])
    assert.match(view.container.textContent, /Shell row became unavailable/)
    assert.match(view.container.textContent, /Changes may have occurred/)
    assert.equal(view.container.querySelector('[role=region]'), null)
  } finally { await view.close() }
})

await test('cancelled runtime execution preserves unknown effects and unavailable plans cannot execute', async () => {
  const api = defaultApi(); let signal, finish, executions = 0
  api.execute = async (_id, inputSignal) => { executions++; signal = inputSignal; return new Promise(resolve => { finish = () => resolve({ ok: false, error: { message: 'Remote call cancelled after launch.' } }); inputSignal.addEventListener('abort', finish, { once: true }) }) }
  const view = await mount(RuntimePanel, { api, editable: true, onSelect() {} })
  try {
    await click(button(view.container, en.previewInstall)); await click(button(view.container, en.install))
    assert.equal(executions, 1); assert.equal(signal.aborted, false)
    await click(button(view.container, en.cancel))
    assert.equal(signal.aborted, true); assert.match(view.container.textContent, /Changes may have occurred/)
    api.plan = async action => ok({ id: 'blocked', action, available: false, details: [], reason: 'Unsupported platform' })
    await click(button(view.container, en.previewInstall))
    assert.equal(button(view.container, en.install).disabled, true)
    assert.equal(executions, 1)
  } finally { finish?.(); await view.close() }
})

await test('an older failed runtime refresh cannot replace a newer successful status', async () => {
  const pending = [], api = defaultApi()
  api.snapshot = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  const view = await mount(RuntimePanel, { api, editable: true, onSelect() {} })
  try {
    await click(button(view.container, en.refresh))
    await act(async () => pending[1].resolve(ok(snapshot)))
    await act(async () => pending[0].reject(new Error('obsolete network failure')))
    assert.equal(view.container.textContent.includes('obsolete network failure'), false)
    assert.equal(button(view.container, en.git).disabled, false)
  } finally { await view.close() }
})

await test('unavailable settings expose recovery instructions without an editable form', async () => {
  const view = await mount(ReplacementForm, { form: { state: { status: 'unavailable', value: {} } } })
  try { assert.equal(view.container.querySelector('form'), null); assert.match(view.container.textContent, /built-in switch/); assert.equal(view.container.querySelector('input'), null) }
  finally { await view.close() }
})
dom.window.close()
report('settings-ui')
