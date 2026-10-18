import { setImmediate } from 'node:timers/promises'
import { assert, test, report } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { resultSessionNonce, registerResultCleanup, withResultSession, expireResultSession, mountResultLifecycle } from '../lib/kernel/result-lifecycle.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

await test('disposal cancels owned work, waits for settlement, then purges exactly once', async () => {
  const ctx = {}, session = { id: 'one' }, settled = deferred(), events = []
  const nonce = resultSessionNonce(ctx, session)
  assert.equal(resultSessionNonce(ctx, session), nonce)
  assert.notEqual(resultSessionNonce({}, session), nonce)
  registerResultCleanup(ctx, session, 'cache', async () => { events.push('purged') })
  const work = withResultSession(ctx, session, undefined, async signal => {
    signal.addEventListener('abort', () => events.push('aborted'), { once: true })
    await settled.promise; events.push('settled')
  })
  await setImmediate()
  const closing = expireResultSession(ctx, session)
  assert.equal(expireResultSession(ctx, session), closing)
  assert.deepEqual(events, ['aborted'])
  await assert.rejects(withResultSession(ctx, session, undefined, async () => assert.fail('disposed work ran')), /expired/)
  const reopened = { id: 'one' }
  const next = withResultSession(ctx, reopened, undefined, async () => events.push('reopened'))
  await setImmediate(); assert.deepEqual(events, ['aborted'])
  settled.resolve(); await Promise.all([work, closing, next])
  assert.deepEqual(events, ['aborted', 'settled', 'purged', 'reopened'])
  assert.notEqual(resultSessionNonce(ctx, reopened), nonce)
  await expireResultSession(ctx, reopened)
})

await test('two component owners share the live session; last unload expires it', async () => {
  const { ctx } = await bootHost(), session = { id: 'components' }
  let purged = 0
  try {
    const first = await ctx.plugin(inner => mountResultLifecycle(inner))
    const second = await ctx.plugin(inner => mountResultLifecycle(inner))
    registerResultCleanup(ctx, session, 'cache', async () => { purged++ })
    const nonce = resultSessionNonce(ctx, session)
    await first.dispose()
    assert.equal(purged, 0); assert.equal(resultSessionNonce(ctx, session), nonce)
    await second.dispose()
    assert.equal(purged, 1)
    assert.throws(() => resultSessionNonce(ctx, session), /expired/)
  } finally { await shutdown(ctx) }
})

await test('real host session-disposed event expires references and contains cleanup failure', async () => {
  const { ctx } = await bootHost(), session = { id: 'event' }, done = deferred()
  let warnings = 0
  try {
    const fiber = await ctx.plugin(inner => mountResultLifecycle(inner))
    registerResultCleanup(ctx, session, 'cache', async () => { done.resolve(); throw new Error('read-only') })
    ctx.emit('session/disposed', session)
    await done.promise; await setImmediate()
    assert.throws(() => resultSessionNonce(ctx, session), /expired/)
    const direct = { logger: { warn() { warnings++ } } }, other = { id: 'deferred' }
    registerResultCleanup(direct, other, 'cache', async () => { throw new Error('read-only') })
    await expireResultSession(direct, other); assert.equal(warnings, 1)
    await fiber.dispose()
  } finally { await shutdown(ctx) }
})
report('result-lifecycle')
