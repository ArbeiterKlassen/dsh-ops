/** Full native file surface: real worker + real DSH subprocess/policy/fs observations. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { invoke } from '../lib/file/worker.js'
import { FILE_TOOLS, FILE_MUTATIONS, publicToolName } from '../lib/policy.js'
import { PARAMETERS, definition, normalizeArguments } from '../lib/file/contract.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker, WORKER } from './lib/boundary.mjs'
requireWorker('file-operations')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const call = async (tool, args, root, options = {}) => envelopeOf(await callTool(tool, args, { root, ...options }), assert)
const failed = (value, code) => { assert.equal(value.status, 'error', JSON.stringify(value)); assert.equal(value.error.code, code, JSON.stringify(value)); assert.equal(value.error.effectState, 'none') }
const mutation = (value, target, content) => {
  if (process.platform === 'win32') { failed(value, 'METADATA_UNSUPPORTED'); return false }
  assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(fs.readFileSync(target, 'utf8'), content); return true
}
const rev = target => hash(fs.readFileSync(target))

await test('every new contract is strict, named consistently, and never marks writes concurrency-safe', () => {
  for (const raw of FILE_TOOLS) {
    const tool = definition(raw, () => {})
    assert.equal(tool.name, publicToolName(raw)); assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.isConcurrencySafe === 'function', !FILE_MUTATIONS.includes(raw))
  }
  for (const raw of ['write_file', 'edit_file', 'copy', 'move', 'remove']) assert.ok(PARAMETERS[raw].required.includes('expectedRevision'))
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: '', expectedRevision: 'absent', dryRun: false }), { path: 'a', content: '', expectedRevision: 'absent', dryRun: false })
})
await test('inspect/stat share exact hashes and total line counts even for a partial read, empty or binary file', async () => {
  await withTempDir('file-stat', async root => {
    for (const [name, bytes, lineCount] of [['crlf', Buffer.from('\ufeffα\r\nβ\r\n'), 2], ['empty', Buffer.alloc(0), 0], ['binary', Buffer.from([0xff, 0]), null]]) {
      const target = path.join(root, name); fs.writeFileSync(target, bytes)
      const stat = await call('stat', { path: target }, root)
      assert.equal(stat.revision, hash(bytes)); assert.equal(stat.bytes, bytes.length); assert.equal(stat.lineCount, lineCount)
      assert.equal(stat.exists, true); assert.equal(typeof stat.modifiedMs, 'number'); assert.equal(stat.items, undefined)
      const read = await call('inspect_local_file', { path: target, limit: 1, view: name === 'binary' ? 'hex' : 'text' }, root)
      assert.equal(read.revision, stat.revision); assert.equal(read.lineCount, stat.lineCount); assert.equal(read.bytes, bytes.length)
    }
    const large = path.join(root, 'large'); fs.writeFileSync(large, Buffer.alloc(200_000, 1))
    const hex = await callTool('inspect_local_file', { path: large, view: 'hex', limit: 10000 }, { root })
    assert.ok(Buffer.byteLength(hex.stdout) < 128 * 1024); assert.equal(hex.body.complete, false); assert.equal(hex.body.nextOffset, 1901)
    const absent = await call('stat', { path: path.join(root, 'absent') }, root)
    assert.equal(absent.exists, false); assert.equal(absent.revision, 'absent')
  })
})
await test('full writes create empty/Unicode files, refuse stale/absent overwrites and produce short stable receipts', async () => {
  await withTempDir('file-write', async root => {
    const target = path.join(root, 'new.txt')
    const created = await call('write_file', { path: target, expectedRevision: 'absent', content: 'α\r\nβ\n' }, root)
    assert.equal(created.status, 'completed', JSON.stringify(created)); assert.equal(created.changed, 1)
    assert.equal(created.revision, rev(target)); assert.equal(created.lineCount, 2); assert.ok(JSON.stringify(created).length < 2000)
    failed(await call('write_file', { path: target, expectedRevision: 'absent', content: 'bad' }, root), 'REVISION_CONFLICT')
    failed(await call('write_file', { path: target, expectedRevision: '0'.repeat(64), content: 'bad' }, root), 'REVISION_CONFLICT')
    const dry = await call('write_file', { path: target, expectedRevision: created.revision, content: '', dryRun: true }, root)
    assert.equal(dry.changed, 0); assert.equal(dry.revision, hash('')); assert.equal(fs.readFileSync(target, 'utf8'), 'α\r\nβ\n')
    const written = await call('write_file', { path: target, expectedRevision: created.revision, content: '' }, root)
    mutation(written, target, '')
    if (process.platform === 'win32') assert.equal(fs.readFileSync(target, 'utf8'), 'α\r\nβ\n')
    const empty = await call('write_file', { path: path.join(root, 'empty'), expectedRevision: 'absent', content: '' }, root)
    assert.equal(empty.lineCount, 0); assert.equal(empty.bytes, 0)
    const noop = await call('write_file', { path: target, expectedRevision: rev(target), content: fs.readFileSync(target, 'utf8') }, root)
    assert.equal(noop.changed, 0)
  })
})
await test('precise edits use one original, preserve Unicode/CRLF/BOM and reject all ambiguous/overlapping hunks', async () => {
  await withTempDir('file-edit', async root => {
    const target = path.join(root, 'patch.txt'); const original = '\ufeffalpha\r\nβeta\r\nend\r\n'
    fs.writeFileSync(target, original)
    const expectedRevision = rev(target)
    for (const edits of [[{ oldText: '', newText: 'x' }], [{ oldText: 'absent', newText: 'x' }], [{ oldText: 'alpha', newText: 'x' }, { oldText: 'pha', newText: 'y' }]]) {
      const value = await call('edit_file', { path: target, expectedRevision, edits }, root)
      assert.equal(value.status, 'error'); assert.equal(value.error.effectState, 'none'); assert.equal(fs.readFileSync(target, 'utf8'), original)
    }
    const edits = [{ oldText: 'alpha', newText: 'βeta' }, { oldText: 'βeta', newText: 'DONE' }]
    const preview = await call('edit_file', { path: target, expectedRevision, edits, dryRun: true }, root)
    assert.equal(preview.revision, hash('\ufeffβeta\r\nDONE\r\nend\r\n')); assert.equal(preview.changed, 0)
    mutation(await call('edit_file', { path: target, expectedRevision, edits }, root), target, '\ufeffβeta\r\nDONE\r\nend\r\n')
    fs.writeFileSync(target, 'aaa')
    failed(await call('edit_file', { path: target, expectedRevision: rev(target), edits: [{ oldText: 'aa', newText: 'b' }] }, root), 'EDIT_CONFLICT')
    fs.writeFileSync(target, Buffer.from([255]))
    failed(await call('edit_file', { path: target, expectedRevision: rev(target), edits: [{ oldText: 'a', newText: '' }] }, root), 'INVALID_ARGUMENT')
  })
})
await test('diff is a bounded read-only replacement hunk with exact before/after facts and continuation', async () => {
  await withTempDir('file-diff', async root => {
    const target = path.join(root, 'diff.txt'); fs.writeFileSync(target, 'same\na\nb\ntail\n')
    const content = 'same\nA\nB\ntail\n'
    const first = await call('diff', { path: target, content, limit: 1 }, root, { readOnly: true })
    assert.deepEqual(first.hunk, { startLine: 2, removed: 2, added: 2 }); assert.equal(first.complete, false); assert.equal(first.nextOffset, 1)
    assert.equal(first.before.revision, rev(target)); assert.equal(first.after.revision, hash(content)); assert.equal(first.changed, 0)
    const next = await call('diff', { path: target, content, offset: first.nextOffset }, root)
    assert.equal(next.items.length, 3); assert.equal(next.complete, true)
    const none = await call('diff', { path: target, content: fs.readFileSync(target, 'utf8') }, root)
    assert.deepEqual(none.items, []); assert.equal(none.complete, true)
    const large = await callTool('diff', { path: target, content: '\0'.repeat(300_000) }, { root })
    assert.ok(Buffer.byteLength(large.stdout) < 128 * 1024); assert.equal(large.body.truncated, true); assert.equal(large.body.after.bytes, 300_000)
    assert.equal(fs.readFileSync(target, 'utf8'), 'same\na\nb\ntail\n')
  })
})
await test('copy/move/remove require source CAS, absent destination and regular files', async () => {
  await withTempDir('file-transfer', async root => {
    const source = path.join(root, 'source'); const to = path.join(root, 'dest'); fs.writeFileSync(source, Buffer.from([255, 0, 1]))
    const expectedRevision = rev(source)
    for (const tool of ['copy', 'move', 'remove']) failed(await call(tool, { path: source, expectedRevision: '0'.repeat(64), ...(tool === 'remove' ? {} : { to }) }, root), 'REVISION_CONFLICT')
    fs.writeFileSync(to, 'keep')
    for (const tool of ['copy', 'move']) failed(await call(tool, { path: source, to, expectedRevision }, root), 'REVISION_CONFLICT')
    assert.equal(fs.readFileSync(to, 'utf8'), 'keep'); fs.unlinkSync(to)
    const copied = await call('copy', { path: source, to, expectedRevision }, root)
    if (process.platform === 'win32' || process.platform === 'darwin') { failed(copied, 'METADATA_UNSUPPORTED'); assert.equal(fs.existsSync(to), false) }
    else { assert.equal(copied.status, 'completed', JSON.stringify(copied)); assert.equal(rev(to), expectedRevision); fs.unlinkSync(to) }
    const moved = await call('move', { path: source, to, expectedRevision }, root)
    assert.equal(moved.status, 'completed', JSON.stringify(moved)); assert.equal(fs.existsSync(source), false); assert.equal(rev(to), expectedRevision)
    const removed = await call('remove', { path: to, expectedRevision }, root)
    assert.equal(removed.changed, 1); assert.equal(fs.existsSync(to), false)
    for (const tool of ['stat', 'diff', 'write_file', 'copy', 'move', 'remove']) {
      const value = await call(tool, { path: root, ...(tool === 'diff' ? { content: '' } : {}), ...(['write_file', 'copy', 'move', 'remove'].includes(tool) ? { expectedRevision, ...(tool === 'write_file' ? { content: '' } : tool === 'remove' ? {} : { to }) } : {}) }, root)
      assert.equal(value.status, 'error', tool); assert.ok(['IS_DIRECTORY', 'REVISION_CONFLICT'].includes(value.error.code), JSON.stringify(value))
    }
  })
})
await test('create-only concurrent writers publish exactly one entire file without lost updates', async () => {
  await withTempDir('file-cas-race', async root => {
    const target = path.join(root, 'raced')
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('write_file', { path: target, content: `writer ${i}\n`, expectedRevision: 'absent' }, root)))
    const winners = results.filter(v => v.status === 'completed')
    assert.equal(winners.length, 1, JSON.stringify(results)); assert.equal(winners[0].revision, rev(target))
    for (const loser of results.filter(v => v.status !== 'completed')) failed(loser, 'REVISION_CONFLICT')
  })
})
await test('concurrent full overwrites share a revision and only one publication survives', async () => {
  if (process.platform === 'win32') return // explicit DACL refusal is exercised separately
  await withTempDir('file-overwrite-race', async root => {
    const target = path.join(root, 'raced'); fs.writeFileSync(target, 'original')
    const expectedRevision = rev(target)
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('write_file', { path: target, content: `writer ${i}`, expectedRevision }, root)))
    const winners = results.filter(v => v.status === 'completed')
    assert.equal(winners.length, 1, JSON.stringify(results)); assert.equal(winners[0].revision, rev(target))
    for (const loser of results.filter(v => v.status !== 'completed')) failed(loser, 'REVISION_CONFLICT')
  })
})
await test('no-follow ancestry rejects symlinks/junctions even for a missing write destination', async () => {
  await withTempDir('file-no-follow', async root => {
    const real = path.join(root, 'real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'a'), 'keep')
    const link = path.join(root, 'link'); fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    for (const tool of ['stat', 'write_file', 'edit_file', 'copy', 'move', 'remove']) {
      const value = await call(tool, { path: path.join(link, tool === 'write_file' ? 'new' : 'a'), ...(tool === 'stat' ? {} : { expectedRevision: tool === 'write_file' ? 'absent' : hash('keep') }), ...(tool === 'write_file' ? { content: 'bad' } : tool === 'edit_file' ? { edits: [{ oldText: 'keep', newText: 'bad' }] } : ['copy', 'move'].includes(tool) ? { to: path.join(root, 'dest') } : {}) }, root)
      failed(value, 'POLICY_DENIED')
    }
    assert.equal(fs.existsSync(path.join(real, 'new')), false); assert.equal(fs.readFileSync(path.join(real, 'a'), 'utf8'), 'keep')
  })
})
await test('three authoritative modes, both transfer paths, credential fence, live downgrade and host observations', async () => {
  await withTempDir('file-authority', async root => {
    await withTempDir('file-outside', async outside => {
      const { ctx } = await bootHost(); const session = { id: 'file-authority', mode: 'read-only', header: { cwd: root } }
      const exec = { agent: { session }, signal: new AbortController().signal }
      try {
        await ctx.plugin(Subprocess); await ctx.plugin(FileSystem, {}); await ctx.plugin(ObservationPolicy)
        let resolves = 0; let downgrade = false
        await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve() { resolves++; if (downgrade && resolves === 2) session.mode = 'read-only'; return { mode: session.mode, workspaceRoot: root } } }))
        const invokeTool = (tool, args) => invoke(ctx, WORKER, tool, args, exec, exec.signal)
        const source = path.join(outside, 'source'); fs.writeFileSync(source, 'outside')
        const operations = { write_file: { path: 'new', content: 'new', expectedRevision: 'absent' }, edit_file: { path: source, expectedRevision: rev(source), edits: [{ oldText: 'outside', newText: 'bad' }] }, copy: { path: source, to: 'copy', expectedRevision: rev(source) }, move: { path: source, to: 'move', expectedRevision: rev(source) }, remove: { path: source, expectedRevision: rev(source) } }
        for (const [tool, args] of Object.entries(operations)) { const value = await invokeTool(tool, args); assert.equal(value.error.code, 'POLICY_DENIED'); assert.match(value.error.nextAction, /Ask the user/); assert.equal(value.error.permission.current, 'read-only') }
        assert.equal((await invokeTool('stat', { path: source })).status, 'completed')
        session.mode = 'workspace-write'
        for (const tool of ['move', 'remove', 'edit_file']) assert.equal((await invokeTool(tool, operations[tool])).error.code, 'POLICY_DENIED')
        for (const tool of ['write_file', 'copy']) {
          const args = tool === 'copy' ? { ...operations.copy, to: path.join(outside, 'bad') } : { ...operations.write_file, path: path.join(outside, 'bad') }
          assert.equal((await invokeTool(tool, args)).error.code, 'POLICY_DENIED')
        }
        const linked = path.join(root, 'linked'); fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
        const throughLink = await invokeTool('write_file', { path: path.join(linked, 'escape'), content: 'bad', expectedRevision: 'absent' })
        assert.equal(throughLink.error.code, 'POLICY_DENIED'); assert.equal(fs.existsSync(path.join(outside, 'escape')), false)
        session.mode = 'danger-full-access'
        const fullLink = await invokeTool('write_file', { path: path.join(linked, 'escape'), content: 'bad', expectedRevision: 'absent' })
        assert.equal(fullLink.error.code, 'POLICY_DENIED'); assert.equal(fs.existsSync(path.join(outside, 'escape')), false)
        session.mode = 'workspace-write'
        const beforeSourceNames = fs.readdirSync(outside).sort()
        const copySource = await invokeTool('copy', { path: source, to: 'external-copy', expectedRevision: rev(source) })
        if (['win32', 'darwin'].includes(process.platform)) assert.equal(copySource.error.code, 'METADATA_UNSUPPORTED')
        else { assert.equal(copySource.status, 'completed', JSON.stringify(copySource)); assert.equal(fs.readFileSync(path.join(root, 'external-copy'), 'utf8'), 'outside') }
        assert.deepEqual(fs.readdirSync(outside).sort(), beforeSourceNames, 'read-only source must not receive sidecar writes')
        assert.equal(fs.readFileSync(source, 'utf8'), 'outside')
        const target = path.join(root, 'new'); const created = await invokeTool('write_file', operations.write_file)
        assert.equal(created.status, 'completed', JSON.stringify(created)); assert.equal(created.sandbox.mode, 'workspace-write')
        const fsTarget = await ctx.get('fs').resolve(target, { cwd: root })
        const intent = () => ctx.waterfall('fs/edit-intent', fsTarget, exec, () => undefined)
        assert.deepEqual(await intent(), { version: (await ctx.get('fs').stat(fsTarget)).version })
        await invokeTool('remove', { path: target, expectedRevision: created.revision })
        await assert.rejects(intent(), error => error.code === 'FS_NOT_FOUND')
        session.mode = 'danger-full-access'
        const full = await invokeTool('write_file', { path: path.join(outside, 'full'), content: 'ok', expectedRevision: 'absent' })
        assert.equal(full.status, 'completed', JSON.stringify(full))
        for (const [tool, args] of [['stat', { path: path.join(root, '.env') }], ['write_file', { path: path.join(root, '.env'), content: 'bad', expectedRevision: 'absent' }], ['copy', { path: source, to: path.join(root, '.env'), expectedRevision: rev(source) }]]) {
          const value = await invokeTool(tool, args); assert.equal(value.error.code, 'POLICY_DENIED'); assert.doesNotMatch(JSON.stringify(value), /outside.*outside/s)
        }
        resolves = 0; downgrade = true
        const changed = await invokeTool('write_file', { path: 'downgrade', content: 'bad', expectedRevision: 'absent' })
        assert.equal(changed.error.code, 'POLICY_DENIED'); assert.equal(fs.existsSync(path.join(root, 'downgrade')), false)
        const noAuthority = await invoke({ get() { throw new Error('private infrastructure details') } }, WORKER, 'stat', { path: source }, exec, exec.signal)
        assert.equal(noAuthority.error.code, 'EXECUTOR_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(noAuthority), /private infrastructure/)
      } finally { await shutdown(ctx) }
    })
  })
})
await test('Windows DACLs survive fail-closed overwrite/edit/replace/copy and inode-preserving move', async () => {
  if (process.platform !== 'win32') return
  await withTempDir('file-dacl', async root => {
    const source = path.join(root, 'secure'); fs.writeFileSync(source, 'keep')
    const ps = code => {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } })
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
    }
    const quoted = source.replaceAll("'", "''")
    ps(`$p='${quoted}'; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $p -AclObject $a`)
    const acl = target => ps(`(Get-Acl -LiteralPath '${target.replaceAll("'", "''")}').Sddl`)
    const before = acl(source); const expectedRevision = rev(source)
    for (const [tool, args] of [['write_file', { content: 'bad', expectedRevision }], ['edit_file', { expectedRevision, edits: [{ oldText: 'keep', newText: 'bad' }] }], ['replace', { pattern: 'keep', replacement: 'bad' }], ['copy', { expectedRevision, to: path.join(root, 'copy') }]]) {
      failed(await call(tool, { path: source, ...args }, root), 'METADATA_UNSUPPORTED'); assert.equal(acl(source), before); assert.equal(fs.readFileSync(source, 'utf8'), 'keep')
    }
    const dry = await call('replace', { path: source, pattern: 'keep', replacement: 'bad', dryRun: true }, root)
    assert.equal(dry.dryRun, true); assert.equal(dry.changed, 0)
    const dest = path.join(root, 'moved'); const moved = await call('move', { path: source, to: dest, expectedRevision }, root)
    assert.equal(moved.status, 'completed', JSON.stringify(moved)); assert.equal(acl(dest), before)
    // Hold a non-delete-sharing Windows handle: hard-link publication succeeds,
    // but unlink must report an applied partial effect and retain the source.
    fs.renameSync(dest, source)
    const code = `$h=[IO.File]::Open('${quoted}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $h.Dispose()`
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', code => reject(new Error(`holder exited ${code}`))) })
      const partial = await call('move', { path: source, to: dest, expectedRevision }, root)
      assert.equal(partial.error.code, 'RESULT_PARTIAL', JSON.stringify(partial)); assert.equal(partial.error.effectState, 'applied'); assert.equal(fs.existsSync(source), true); assert.equal(fs.existsSync(dest), true)
    } finally { holder.stdin.end('release' + String.fromCharCode(10)); await new Promise(resolve => holder.once('close', resolve)) }
  })
})
await test('cross-device move rejects without copy/delete fallback when a second writable device is available', async () => {
  await withTempDir('file-device', async root => {
    const source = path.join(root, 'source'); fs.writeFileSync(source, 'keep')
    const candidates = process.platform === 'win32' ? [process.cwd()] : ['/dev/shm', process.cwd()]
    const other = candidates.find(dir => { try { fs.accessSync(dir, fs.constants.W_OK); return fs.statSync(dir).dev !== fs.statSync(root).dev } catch { return false } })
    if (!other) { console.log('  cross-device fixture unavailable: no second writable filesystem'); return }
    const destinationRoot = fs.mkdtempSync(path.join(other, '.tmp-file-device-'))
    try {
      const to = path.join(destinationRoot, 'dest'); failed(await call('move', { path: source, to, expectedRevision: rev(source) }, root), 'CROSS_DEVICE')
      assert.equal(fs.readFileSync(source, 'utf8'), 'keep'); assert.equal(fs.existsSync(to), false)
    } finally { fs.rmSync(destinationRoot, { recursive: true, force: true }) }
  })
})
report('file-operations')
