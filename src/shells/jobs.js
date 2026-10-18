// Adapted from @deepseek-ai/dsh-tool-bash 0.2.0-rc.2 (MIT). See licenses/deepseek-harness/LICENSE.
/** Adapt one OPS execution to the host job registry without replacing its lifecycle. */
import { hostForeground } from './host-contract.js'

const running = view => ['running', 'stopping'].includes(view.status)

export function startBashJob(jobs, args, exec, start) {
  let process
  let stopped
  const output = ['stdout', 'stderr'].map(stream => ({
    channel: stream,
    read: offset => process?.observed[stream].readFrom(offset) ?? { text: '', nextOffset: offset, lossy: false },
  }))
  const id = jobs.start({ kind: 'bash', label: args.command ?? args.script_path,
    ...(exec.agent ? { owner: exec.agent.id } : {}), output,
    run: () => {
      const cancellation = new AbortController()
      const done = Promise.resolve().then(async () => {
        cancellation.signal.throwIfAborted()
        process = await start({ ...exec, signal: cancellation.signal }, { onExpiry: 'none' })
        if (cancellation.signal.aborted) process.kill(stopped)
        const value = await process.result()
        const state = value.cancelled || value.signal || value.timedOut ? 'killed' : value.error ? 'failed' : 'completed'
        const detail = value.error ?? (value.signal ? `signal: ${value.signal}` : `exit code: ${value.exitCode ?? 0}`)
        const sandbox = value.sandbox?.runnerFailed ? '; sandbox runner failed before the command ran'
          : value.sandbox?.denied ? `; sandbox denied file access under ${value.sandbox.mode} mode` : ''
        return { status: state, detail: detail + sandbox }
      }).catch(error => ({ status: cancellation.signal.aborted ? 'killed' : 'failed', detail: String(error?.message ?? error) }))
      return { done, cancel: reason => { stopped = reason; cancellation.abort(new Error(reason)); process?.kill(reason) } }
    },
  })
  return { id, process: () => process, stopped: () => stopped }
}

export async function waitOnBashJob(jobs, attached, exec, timeoutMs) {
  const owner = exec.agent?.id
  const stop = async reason => {
    jobs.kill(attached.id, owner, reason)
    const settled = await jobs.wait(attached.id, timeoutMs, owner)
    if (!running(settled)) jobs.remove(attached.id, owner)
  }
  let view
  try { view = await jobs.wait(attached.id, timeoutMs, owner, exec.signal) }
  catch (error) { await stop('tool call aborted'); throw error }
  if (running(view)) {
    if (!attached.process()?.started) {
      await stop('timed out during preparation')
      return hostForeground({ timedOut: true, timeoutMs,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
    }
    const read = jobs.read(attached.id, owner)
    const stdout = read.chunks.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
    const stderr = read.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
    const text = stdout + (stderr ? `${stdout && !stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}` : '')
    const loss = read.lossy ? '\n[some output was dropped from memory; full output: '
      + ((read.job.output.spillPaths ?? []).join(', ') || '(unavailable)') + ']' : ''
    return { kind: 'promoted', jobId: attached.id, timeoutMs, output: text + loss }
  }
  jobs.remove(attached.id, owner)
  const process = attached.process()
  if (!process) throw new Error(view.detail ?? 'Bash job preparation failed')
  return hostForeground({ ...await process.result(), ...(attached.stopped() ? { stopped: attached.stopped() } : {}) })
}
