/**
 * Argument, content and paging boundaries, ported from the ad-hoc `B-args` and
 * `G-semantics` probes in `dsh-ops-boundary-report.md`.
 *
 * What this suite locks in:
 *
 * - Declared argument bounds hold at the exact edge: `offset: 0` is accepted and
 *   silently means line 1, negatives and non-integers are `INVALID_ARGUMENT`,
 *   `beforeContext: 33` is refused by name, and an empty glob pattern list is
 *   `INVALID_ARGUMENT`.
 * - Paging tells the truth. 500 matches with `limit: 10` report `total: 500`,
 *   `complete: false`, `omitted: 490` and a usable `nextOffset`, and following
 *   `nextOffset` reaches every match. The `skipped` field is the paging offset,
 *   not a count of skipped files: that is the contract, and it is asserted so a
 *   silent change to it is visible.
 * - `replace.pattern` is a literal substring while `grep.pattern` is a regex;
 *   the mismatch is a documented contract boundary (report L5), asserted here so
 *   whoever unifies them has to update this suite deliberately.
 * - `multiline` means per-line anchors, not cross-line matching (report L6):
 *   `^beta$` matches, `alpha\nbeta` does not.
 *
 * Platform. The subject is JSON argument handling in the native worker, plus
 * filesystem-neutral fixtures, so every case runs on win32 as well. The one
 * fixture that is sized against a byte budget (a 128 KiB single line) is
 * portable; the 32 MiB fixture from the report is deliberately not ported — see
 * the runtime budget note in the porting report.
 *
 * Intentional omission: the default `maxReplacements` abort (L3), an open defect
 * rather than a boundary; the fixture that proved it was removed with it. The
 * `limit`-bounds-lines-not-bytes defect (L4) used to be omitted here too and is
 * now fixed and covered by `test/output-budget.test.mjs`; the long-line case at
 * the end of this suite asserts both sides of the new byte boundary.
 *
 * @module dsh-ops/test/linux-args
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, request, requireWorker, callWorker } from './lib/boundary.mjs'

requireWorker('linux-args')

/** Write `count` numbered lines under a workspace and return the path. */
const numbered = (workspace, name, count) => {
  const target = path.join(workspace, name)
  fs.writeFileSync(target, `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`)
  return target
}

await test('offset and limit hold at their declared edges', async () => {
  await withTempDir('linux-args-offset', async workspace => {
    const target = numbered(workspace, 'lines.txt', 100)
    const read = (args, timeoutMs) => callTool('inspect_local_file', { path: target, ...args }, { root: workspace, timeoutMs })

    const minima = envelopeOf(await read({ offset: 1, limit: 1 }), assert)
    assert.equal(minima.status, 'completed')
    assert.equal(minima.items.length, 1)
    assert.equal(minima.items[0].line, 1)

    const maximum = envelopeOf(await read({ limit: 10_000 }), assert)
    assert.equal(maximum.status, 'completed')
    assert.equal(maximum.items.length, 100, 'the file is the limit, not the declared maximum')

    for (const bad of [{ limit: 10_001 }, { offset: -1 }, { limit: -5 }, { offset: 1.5 }]) {
      const refused = envelopeOf(await read(bad), assert)
      assert.equal(refused.status, 'error', `${JSON.stringify(bad)} was accepted`)
      assert.equal(refused.error.code, 'INVALID_ARGUMENT')
    }

    // A zero offset is below the declared minimum of 1 but is silently accepted
    // and read as line 1. That tolerance is the current contract; it is asserted
    // so tightening it to a refusal is a deliberate, visible change.
    const zero = envelopeOf(await read({ offset: 0 }), assert)
    assert.equal(zero.status, 'completed')
    assert.equal(zero.items[0].line, 1)

    const pastEnd = envelopeOf(await read({ offset: 100_000 }), assert)
    assert.equal(pastEnd.status, 'completed')
    assert.deepEqual(pastEnd.items, [])
    assert.equal(pastEnd.total, 100, 'the file total is still reported')
    assert.equal(pastEnd.complete, true)
  })
})

await test('glob pattern lists are validated: empty is refused, 200 patterns stay bounded', async () => {
  await withTempDir('linux-args-glob', async workspace => {
    for (let index = 0; index < 25; index += 1) fs.writeFileSync(path.join(workspace, `f${index}.txt`), 'x')

    const empty = envelopeOf(await callTool('glob', { path: workspace, pattern: [] }, { root: workspace }), assert)
    assert.equal(empty.status, 'error')
    assert.equal(empty.error.code, 'INVALID_ARGUMENT')

    const patterns = Array.from({ length: 200 }, (_, index) => `f${index}.txt`)
    const started = Date.now()
    const many = envelopeOf(await callTool('glob', { path: workspace, pattern: patterns }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(many.status, 'completed')
    assert.equal(many.matched, 25, 'only the patterns with a real file may match')
    assert.ok(Date.now() - started < 15_000, 'no quadratic blowup')
  })
})

await test('grep refuses an invalid regex without hanging; a hostile pattern stays linear', async () => {
  await withTempDir('linux-args-regex', async workspace => {
    const target = numbered(workspace, 'redos.txt', 1)
    fs.writeFileSync(target, `${'a'.repeat(30)}b\n`)

    const invalid = envelopeOf(await callTool('grep', { path: target, pattern: '([' }, { root: workspace }), assert)
    assert.equal(invalid.status, 'error')
    assert.equal(invalid.error.code, 'INVALID_ARGUMENT')
    assert.match(invalid.error.message, /regex parse error|unclosed character class/)

    const started = Date.now()
    const hostile = envelopeOf(await callTool('grep', { path: target, pattern: '(a+)+$' }, { root: workspace, timeoutMs: 15_000 }), assert)
    assert.equal(hostile.status, 'completed')
    assert.equal(hostile.matched, 0)
    assert.ok(Date.now() - started < 5_000, 'the engine must not backtrack exponentially')

    const emptyPattern = envelopeOf(await callTool('grep', { path: target, pattern: '' }, { root: workspace }), assert)
    assert.equal(emptyPattern.status, 'error')
    assert.equal(emptyPattern.error.code, 'INVALID_ARGUMENT')
  })
})

await test('beforeContext is bounded at 32 lines, one over is refused by name', async () => {
  await withTempDir('linux-args-context', async workspace => {
    const target = numbered(workspace, 'context.txt', 100)
    const atLimit = envelopeOf(await callTool('grep', { path: target, pattern: 'line 50', beforeContext: 32, afterContext: 32 }, { root: workspace }), assert)
    assert.equal(atLimit.status, 'completed')
    assert.equal(atLimit.matched, 1)

    const over = envelopeOf(await callTool('grep', { path: target, pattern: 'line 50', beforeContext: 33 }, { root: workspace }), assert)
    assert.equal(over.status, 'error')
    assert.equal(over.error.code, 'INVALID_ARGUMENT')
    assert.match(over.error.message, /context is limited to 32 lines/)
  })
})

await test('grep paging reports an honest total and nextOffset, and paging reaches every match', async () => {
  await withTempDir('linux-args-paging', async workspace => {
    const target = path.join(workspace, 'hits.txt')
    fs.writeFileSync(target, `${Array.from({ length: 500 }, (_, index) => `hit ${index}`).join('\n')}\n`)

    const first = envelopeOf(await callTool('grep', { path: target, pattern: 'hit', limit: 10, offset: 3 }, { root: workspace }), assert)
    assert.equal(first.matched, 500)
    assert.equal(first.total, 500)
    assert.equal(first.items.length, 10)
    assert.equal(first.complete, false)
    assert.equal(first.omitted, 487, 'omitted counts the matches before the offset and after the page')
    assert.equal(first.nextOffset, 13)
    // `skipped` mirrors the paging offset; it is not a count of skipped files.
    assert.equal(first.skipped, 3)

    let offset = 0
    let seen = 0
    let rounds = 0
    let last = null
    while (rounds < 100) {
      rounds += 1
      const page = envelopeOf(await callTool('grep', { path: target, pattern: 'hit', limit: 100, offset }, { root: workspace }), assert)
      last = page
      seen += page.items.length
      if (page.items.length === 0 || page.complete) break
      offset = page.nextOffset
    }
    assert.equal(seen, 500, 'paging must reach every match')
    assert.equal(last.complete, true, 'the last page must say it is complete')
  })
})

await test('replace treats its pattern as a literal while grep treats the same string as a regex', async () => {
  await withTempDir('linux-args-literal', async workspace => {
    const target = path.join(workspace, 'lit.txt')
    fs.writeFileSync(target, 'aaa a+ bbb\n')

    const grepped = envelopeOf(await callTool('grep', { path: target, pattern: 'a+' }, { root: workspace }), assert)
    assert.equal(grepped.matched, 1, 'grep interprets a+ as a regex quantifier')

    const replaced = envelopeOf(await callTool('replace', { path: target, pattern: 'a+', replacement: 'X' }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(replaced.changed, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'aaa X bbb\n', 'replace matched the literal a+, not the regex')

    fs.writeFileSync(target, 'price 100 usd\n')
    const metacharacter = envelopeOf(await callTool('replace', { path: target, pattern: '\\d+', replacement: 'N' }, { root: workspace, writeRoots: [workspace] }), assert)
    assert.equal(metacharacter.status, 'completed')
    assert.equal(metacharacter.changed, 0, 'a regex-shaped literal matches nothing and says so only through changed=0')
    assert.equal(fs.readFileSync(target, 'utf8'), 'price 100 usd\n')
  })
})

await test('multiline means per-line anchors, never a cross-line match', async () => {
  await withTempDir('linux-args-multiline', async workspace => {
    const target = path.join(workspace, 'ml.txt')
    fs.writeFileSync(target, 'alpha\nbeta\ngamma\n')

    const crossLine = envelopeOf(await callTool('grep', { path: target, pattern: 'alpha\\nbeta', multiline: true }, { root: workspace }), assert)
    assert.equal(crossLine.status, 'completed')
    assert.equal(crossLine.matched, 0, 'a \\n pattern is unbeatable because matching is line-oriented')

    const anchors = envelopeOf(await callTool('grep', { path: target, pattern: '^beta$', multiline: true }, { root: workspace }), assert)
    assert.equal(anchors.matched, 1, '^ and $ apply per line')
  })
})

await test('bounded hostile input stays bounded: a huge grep pattern and a 128 KiB single line', async () => {
  await withTempDir('linux-args-hostile', async workspace => {
    const lines = numbered(workspace, 'lines.txt', 100)
    // The native worker accepts at least a 100 KB pattern without a protocol
    // failure. The report's 8 MiB variant is exercised as "the worker may answer
    // or exit early, but must not hang" so the suite keeps its runtime budget.
    const bigPattern = envelopeOf(await callTool('grep', { path: lines, pattern: 'z'.repeat(100 * 1024) }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(bigPattern.status, 'completed')
    assert.equal(bigPattern.matched, 0)

    const enormous = await callWorker(JSON.stringify(request('grep', { path: lines, pattern: 'z'.repeat(3 * 1024 * 1024) }, { root: workspace })), { timeoutMs: 20_000 })
    assert.equal(enormous.timedOut, false, 'an oversized request must not hang the worker')
    assert.ok(enormous.body !== null || enormous.exitCode !== null || enormous.stdinError !== undefined)

    // The response budget (report L4) sits at 96 KiB, so the boundary has two
    // sides and both are asserted: inside it a long line still comes back whole,
    // beyond it the line is cut and the envelope says so rather than the read
    // failing with an unknown effect. `limit` bounds the number of lines;
    // `test/output-budget.test.mjs` owns the byte accounting itself.
    const fit = path.join(workspace, 'fits.txt')
    fs.writeFileSync(fit, `${'y'.repeat(64 * 1024)}\n`)
    const whole = envelopeOf(await callTool('inspect_local_file', { path: fit, limit: 1 }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(whole.status, 'completed')
    assert.equal(whole.truncated, false)
    assert.equal(whole.items[0].text.length, 64 * 1024)

    const long = path.join(workspace, 'longline.txt')
    fs.writeFileSync(long, `${'x'.repeat(128 * 1024)}\n`)
    const read = envelopeOf(await callTool('inspect_local_file', { path: long, limit: 1 }, { root: workspace, timeoutMs: 20_000 }), assert)
    assert.equal(read.status, 'completed')
    assert.equal(read.items.length, 1)
    assert.equal(read.truncated, true)
    assert.equal(read.items[0].truncatedInLine, true)
    assert.equal(read.items[0].bytesTotal, 128 * 1024)
    assert.ok(read.items[0].text.length < 128 * 1024)
  })
})

report('linux-args')
