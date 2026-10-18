import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { bashToolDefinition } from '../lib/shells.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { startSessionBash } from '../lib/shells/session-execution.js'
import { startBashJob, waitOnBashJob } from '../lib/shells/jobs.js'
import { sessionWorkdir } from '../lib/session-shells.js'
import { assert, report, test, TEST_HOME } from './lib/harness.mjs'

function fixture({ mode = 'danger-full-access', jobs, approval, settle = true, exitCode = 0, file = process.execPath } = {}) {
  const calls = [], pending = Promise.withResolvers()
  const agent = { id: 'shell-host', session: { id: 'shell-host', header: { cwd: TEST_HOME } } }
  const services = { jobs, approval, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: TEST_HOME }) },
    shellEnv: { collect: () => ({ DSH_TEST_FACT: 'current' }) },
    subprocess: { spawn(spec) {
      calls.push(spec)
      const stream = text => ({ readFrom: offset => ({ text: text.slice(offset), nextOffset: text.length, lossy: false }) })
      if (settle) pending.resolve({ exitCode, signal: null })
      else spec.signal.addEventListener('abort', () => pending.resolve({ exitCode: null, signal: 'SIGTERM' }))
      return { done: pending.promise, collected: { stdout: stream('ok'), stderr: stream('warning') } }
    } },
  }
  const ctx = { get: name => services[name], logger: { warn() {} } }
  const bash = { file, source: 'config' }
  const base = bashToolDefinition({ ...bash, subprocess: services.subprocess })
  const definition = hostBashDefinition(ctx, base, (args, exec, standing, policy, env, options) =>
    startSessionBash({ ctx, bash, active: () => true }, args, exec, standing, policy, env, options), sessionWorkdir)
  const exec = { agent, callId: 'shell-call', signal: new AbortController().signal }
  return { definition, exec, services, calls, pending, setMode: next => { mode = next } }
}

function jobRegistry({ promote = false, refuse = false } = {}) {
  let hooks, declaration, state = 'running', outcome, removed = false
  const offsets = { stdout: 0, stderr: 0 }
  return {
    start(spec) {
      if (refuse) throw new Error('owner job limit')
      declaration = spec
      assert.equal(spec.owner, 'shell-host')
      assert.deepEqual(spec.output.map(source => source.channel), ['stdout', 'stderr'])
      hooks = spec.run({ id: 'bash-1' })
      hooks.done.then(value => { outcome = value; state = value.status })
      return 'bash-1'
    },
    async wait(id, _timeout, owner) {
      assert.equal(id, 'bash-1'); assert.equal(owner, 'shell-host')
      if (promote && state === 'running') { await new Promise(resolve => setImmediate(resolve)); return { status: state } }
      await hooks.done
      return { status: state, detail: outcome.detail }
    },
    read(id, owner) {
      assert.equal(id, 'bash-1'); assert.equal(owner, 'shell-host')
      return { chunks: declaration.output.map(source => {
        const read = source.read(offsets[source.channel]); offsets[source.channel] = read.nextOffset
        return { channel: source.channel, text: read.text }
      }), lossy: false, job: { output: { spillPaths: [] } } }
    },
    kill(_id, _owner, reason) { state = 'stopping'; hooks.cancel(reason) },
    remove() { removed = true },
    get declaration() { return declaration }, get hooks() { return hooks }, get removed() { return removed }, get outcome() { return outcome },
  }
}

await test('host foreground calls validate and render the host result contract', async () => {
  const f = fixture()
  assertSupportedJsonSchema(f.definition.output.schema)
  const value = await f.definition.execute({ command: 'echo ok', description: 'Print a short test result' }, f.exec)
  assert.equal(value.kind, 'foreground'); assert.equal(value.exitCode, 0); assert.equal(value.signal, null)
  assert.equal(value.aborted, false); assert.equal(value.status, 'completed'); assert.equal(value.timeoutMs, 120000)
  assert.deepEqual(validateJsonSchemaValue(f.definition.output.schema, value, 'value'), [])
  assert.match(f.definition.output.render({}, value)[0].text, /\[stderr\]\nwarning\n\[exit code: 0\]$/)
  assert.equal(f.calls[0].argv[0], process.execPath)
  assert.equal(f.calls[0].env.DSH_TEST_FACT, 'current')
})

await test('host descriptions are required and timeout overrides cap at ten minutes', async () => {
  const f = fixture()
  await assert.rejects(() => f.definition.execute({ command: 'true' }, f.exec), /invalid description/)
  await assert.rejects(() => f.definition.execute({ command: 'true', description: 'x', timeoutMs: NaN }, f.exec), /invalid timeoutMs/)
  assert.equal(f.calls.length, 0)
  const value = await f.definition.execute({ command: 'true', description: 'Cap the command timeout', timeoutMs: 900000 }, f.exec)
  assert.equal(value.timeoutMs, 600000)
})

await test('approval rejection and missing approval never execute or create jobs', async () => {
  for (const result of ['rejected', 'cancelled', 'unavailable', 'unexpected']) {
    const f = fixture({ mode: 'read-only', approval: { async request(req) {
      assert.equal(req.toolName, 'ops_bash'); assert.equal(req.callId, 'shell-call'); return result
    } } })
    const value = await f.definition.execute({ command: 'true', description: 'Check explicit wider access', sandbox_permissions: 'danger-full-access', justification: 'Need the requested command access.' }, f.exec)
    assert.match(value.error, /APPROVAL_/); assert.equal(f.calls.length, 0)
  }
  const f = fixture({ mode: 'read-only' })
  const value = await f.definition.execute({ command: 'true', description: 'Check missing approval service', sandbox_permissions: 'danger-full-access', justification: 'Need wider access.' }, f.exec)
  assert.match(value.error, /APPROVAL_UNAVAILABLE/); assert.equal(f.calls.length, 0)
})

await test('an allowed-once grant widens only one call and keeps the current environment', async () => {
  let asks = 0
  const f = fixture({ mode: 'read-only', approval: { async request() { asks++; return 'allowed-once' } } })
  const args = { command: 'true', description: 'Run one approved command', sandbox_permissions: 'danger-full-access', justification: 'This command needs wider access.' }
  const first = await f.definition.execute(args, f.exec)
  assert.equal(first.status, 'completed'); assert.equal(first.sandbox.mode, 'danger-full-access')
  const second = await f.definition.execute(args, f.exec)
  assert.equal(second.status, 'completed'); assert.equal(asks, 2)
  assert.equal(f.services.sandboxPolicy.resolve().mode, 'read-only')
})

await test('a session policy change during approval refuses the approved command', async () => {
  const f = fixture({ mode: 'read-only' })
  f.services.approval = { async request() { f.setMode('workspace-write'); return 'allowed-once' } }
  const value = await f.definition.execute({ command: 'true', description: 'Check a racing authority change', sandbox_permissions: 'danger-full-access', justification: 'Need wider access.' }, f.exec)
  assert.match(value.error, /AUTHORITY_CHANGED/); assert.equal(f.calls.length, 0)
})

await test('escalation argument failures precede approval and execution', async () => {
  let asks = 0
  const f = fixture({ approval: { async request() { asks++; return 'allowed-once' } } })
  for (const args of [{ justification: 'orphan' }, { sandbox_permissions: 'workspace-write', justification: 'narrow' }, { sandbox_permissions: 'unknown' }]) {
    await assert.rejects(() => f.definition.execute({ command: 'true', description: 'Validate escalation fields', ...args }, f.exec), /invalid/)
  }
  assert.equal(asks, 0); assert.equal(f.calls.length, 0)
})

await test('completed foreground jobs leave the registry with their result', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs })
  const value = await f.definition.execute({ command: 'true', description: 'Run a foreground host job' }, f.exec)
  assert.equal(value.kind, 'foreground'); assert.equal(jobs.removed, true)
  assert.equal(jobs.outcome.detail, 'exit code: 0')
})

await test('timeout promotion returns the same job and consumes output exactly once', async () => {
  const jobs = jobRegistry({ promote: true }), f = fixture({ jobs, settle: false })
  const value = await f.definition.execute({ command: 'true', description: 'Promote a long running command', timeoutMs: 1 }, f.exec)
  assert.equal(value.kind, 'promoted'); assert.equal(value.jobId, 'bash-1')
  assert.equal(value.output, 'ok\n[stderr]\nwarning')
  assert.equal(jobs.read('bash-1', f.exec.agent.id).chunks.every(chunk => chunk.text === ''), true)
  jobs.kill('bash-1', f.exec.agent.id, 'stop test')
  await jobs.hooks.done
  assert.equal(jobs.outcome.status, 'killed')
})

await test('background returns a host job id and cancellation stops work', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs, settle: false })
  const value = await f.definition.execute({ command: 'true', description: 'Start a cancellable background job', run_in_background: true }, f.exec)
  assert.equal(value.kind, 'background')
  jobs.kill(value.jobId, f.exec.agent.id, 'stop test')
  await jobs.hooks.done
  assert.equal(jobs.outcome.status, 'killed')
})

await test('job admission refusal falls back only for foreground and no hidden work starts', async () => {
  const jobs = jobRegistry({ refuse: true }), f = fixture({ jobs })
  const foreground = await f.definition.execute({ command: 'true', description: 'Use foreground when admission refuses' }, f.exec)
  assert.equal(foreground.kind, 'foreground'); assert.equal(f.calls.length, 1)
  const background = await f.definition.execute({ command: 'true', description: 'Refuse unavailable background admission', run_in_background: true }, f.exec)
  assert.match(background.error, /owner job limit/); assert.equal(f.calls.length, 1)
})


await test('same-mode requests do not prompt and cancellation while approving prevents execution', async () => {
  const f = fixture({ approval: { request() { throw new Error('must not ask') } } })
  const same = await f.definition.execute({ command: 'true', description: 'Retain the current permission mode', sandbox_permissions: 'danger-full-access', justification: '' }, f.exec)
  assert.equal(same.status, 'completed')
  const controller = new AbortController(), approved = Promise.withResolvers()
  const pending = fixture({ mode: 'read-only', approval: { request: () => approved.promise } })
  const call = pending.definition.execute({ command: 'true', description: 'Cancel an approval pending command', sandbox_permissions: 'danger-full-access', justification: 'Request wider access.' }, { ...pending.exec, signal: controller.signal })
  controller.abort(new Error('approval was cancelled')); approved.resolve('allowed-once')
  const value = await call
  assert.equal(value.status, 'failed'); assert.equal(value.aborted, true); assert.match(value.error, /approval was cancelled/)
  assert.equal(pending.calls.length, 0)
})

await test('without jobs the foreground deadline stops execution and background arguments fail', async () => {
  const f = fixture({ settle: false })
  await assert.rejects(() => f.definition.execute({ command: 'true', description: 'Reject unavailable background work', run_in_background: true }, f.exec), /unknown key/)
  assert.equal(f.calls.length, 0)
  // Keep this test alive while the executor's deliberately unref'ed deadline runs.
  const hold = setTimeout(() => {}, 2000)
  try {
    const value = await f.definition.execute({ command: 'true', description: 'Stop the command at expiry', timeoutMs: 5 }, f.exec)
    assert.equal(value.kind, 'foreground'); assert.equal(value.timedOut, true)
    assert.equal(value.status, 'failed'); assert.equal(f.calls[0].signal.aborted, true)
  } finally { clearTimeout(hold) }
})

await test('nonzero exit completes the host job but preserves the failed command status', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs, exitCode: 7 })
  const value = await f.definition.execute({ command: 'exit 7', description: 'Report a nonzero command exit' }, f.exec)
  assert.equal(jobs.outcome.status, 'completed'); assert.equal(jobs.outcome.detail, 'exit code: 7')
  assert.equal(value.exitCode, 7); assert.equal(value.status, 'failed')
})

await test('job cancellation before asynchronous preparation prevents the starter from running', async () => {
  const jobs = jobRegistry(), f = fixture()
  let starts = 0
  const attached = startBashJob(jobs, { command: 'true' }, f.exec, () => { starts++; throw new Error('must not start') })
  assert.deepEqual(jobs.declaration.output[0].read(19), { text: '', nextOffset: 19, lossy: false })
  jobs.kill(attached.id, f.exec.agent.id, 'cancel before preparation')
  await jobs.hooks.done
  assert.equal(starts, 0); assert.equal(jobs.outcome.status, 'killed')
})

await test('an expiring pending preparation is stopped and never promoted', async () => {
  const jobs = jobRegistry({ promote: true }), f = fixture()
  const pending = Promise.withResolvers(); let killed = false
  const attached = startBashJob(jobs, { command: 'true' }, f.exec, () => ({
    started: false, observed: { stdout: { readFrom() {} }, stderr: { readFrom() {} } },
    result: () => pending.promise, kill() { killed = true; pending.resolve({ cancelled: true }) },
  }))
  const value = await waitOnBashJob(jobs, attached, f.exec, 1)
  assert.equal(value.kind, 'foreground'); assert.equal(value.timedOut, true)
  assert.equal(killed, true); assert.equal(jobs.removed, true)
})

await test('an unresolved executable is refused before the host can search PATH', async () => {
  const f = fixture({ file: 'bash' })
  const value = await f.definition.execute({ command: 'true', description: 'Reject an unresolved executable path' }, f.exec)
  assert.match(value.error, /resolved absolute executable path/); assert.equal(f.calls.length, 0)
})

report('shells-host')
