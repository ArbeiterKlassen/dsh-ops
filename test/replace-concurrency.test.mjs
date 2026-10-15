/**
 * Concurrent replacement must not lose an update (report L14).
 *
 * `replace` observes first and publishes second: it records each file's revision,
 * then re-checks that revision immediately before writing. The check alone is
 * check-then-act. Every caller that observes the same pre-image passes it, so
 * several callers report `changed: 1` describing the same edit while only the
 * last rename covers the file — the others' work is gone, and they said it
 * succeeded. Nothing in the envelope contradicts them, which is what makes it a
 * silent loss rather than a visible failure.
 *
 * What this suite locks in, with several writers started on one file at once:
 *
 * - Exactly one caller reports a change, and it is the caller whose replacement is
 *   the one actually present afterwards. A caller may not report a change that is
 *   not in the file.
 * - Every other caller either refuses with an error or reports `changed: 0` having
 *   found its pattern already gone. Both are honest; claiming success is not.
 * - The survivor count is exactly one, so no interleaving quietly merged or
 *   dropped a write, and the file is never left with the pattern half-replaced.
 *
 * The writers use distinct replacements on the same single pattern, so a lost
 * update is directly visible: more than one replacement string in the file, or a
 * caller whose string is absent, is the defect showing through.
 *
 * `test/linux-args.test.mjs` covers the paging and pattern semantics of `replace`;
 * this suite is only about ordering. Advisory locking is POSIX `flock` on Linux
 * and `LockFileEx` on Windows — see `docs/windows-verification.md` for what the
 * Windows behaviour still needs to answer.
 *
 * @module dsh-ops/test/replace-concurrency
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, requireWorker } from './lib/boundary.mjs'

requireWorker('replace-concurrency')

const WRITERS = 6
const TRIALS = 3
const FILLER = 1024 * 1024

/** Read one call's outcome without throwing on any of them. */
const outcome = result => {
  if (result.timedOut || result.exitCode === null || result.spawnError) return { kind: 'crashed', detail: result.spawnError ?? 'timed out' }
  const body = result.body
  if (!body) return { kind: 'crashed', detail: `stdout was not JSON: ${result.parseError}` }
  if (body.status === 'error') return { kind: 'refused', detail: body.code ?? body.message ?? 'error' }
  return { kind: 'reported', changed: body.changed ?? 0, detail: body.status }
}

await test('concurrent replaces never claim a change that did not survive', async () => {
  await withTempDir('replace-concurrency', async workspace => {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const target = path.join(workspace, `trial-${trial}.txt`)
      const filler = 'filler line for the copy\n'.repeat(Math.ceil(FILLER / 25))
      fs.writeFileSync(target, `${filler}TOKEN\n${filler}`)

      const results = await Promise.all(
        Array.from({ length: WRITERS }, (_, index) =>
          callTool('replace', { path: target, pattern: 'TOKEN', replacement: `TOKEN-${index + 1}` }, { root: workspace, timeoutMs: 60_000 }),
        ),
      )

      const final = fs.readFileSync(target, 'utf8')
      const present = []
      for (let writer = 1; writer <= WRITERS; writer += 1) if (final.includes(`TOKEN-${writer}`)) present.push(writer)

      const claims = []
      const details = []
      results.forEach((result, index) => {
        const settled = outcome(result)
        details.push(`writer ${index + 1}: ${settled.kind}${settled.kind === 'reported' ? ` changed=${settled.changed}` : ` (${settled.detail})`}`)
        if (settled.kind === 'crashed') return
        if (settled.kind === 'reported' && settled.changed > 0) claims.push(index + 1)
      })

      assert.equal(
        present.length,
        1,
        `trial ${trial}: exactly one replacement may survive, the file holds [${present.join(', ') || 'none'}] — ${details.join('; ')}`,
      )
      assert.deepEqual(
        claims,
        present,
        `trial ${trial}: the callers reporting a change must be the ones whose change is in the file — ${details.join('; ')}`,
      )
      assert.ok(final.includes('TOKEN-'), `trial ${trial}: the surviving replacement must be present`)
      assert.ok(!final.includes('\nTOKEN\n'), `trial ${trial}: the original pattern must be gone, not half-replaced`)
      assert.equal(final.startsWith('filler line'), true, `trial ${trial}: the untouched prefix must survive intact`)
    }
  })
})

report('replace-concurrency')
