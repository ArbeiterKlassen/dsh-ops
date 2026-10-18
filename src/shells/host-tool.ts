// Adapted from @deepseek-ai/dsh-tool-bash 0.2.0-rc.2 (MIT). See licenses/deepseek-harness/LICENSE.
/** Host-compatible consumer over an OPS-owned executor; host services stay scoped and borrowed. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ShellContext, ShellBase, ShellCall, ShellPolicy, CreateShellExecution, StartShell, HostBashResult, HostShellDefinition } from './types.js'
import { errorMessage } from './types.js'
import { BashArgumentError, isBashArgumentError } from './argument-error.js'
import { approveBashPolicy } from './approval.js'
import { HOST_BASH_OUTPUT_SCHEMA, hostFailure, hostForeground, renderHostBash } from './host-contract.js'
import { startBashJob, waitOnBashJob } from './jobs.js'

export const HOST_MAX_BASH_TIMEOUT_MS = 600_000

export function hostBashDefinition(ctx: ShellContext, base: ShellBase, createExecution: CreateShellExecution,
  resolveWorkdir: (args: Record<string, unknown>, session: NonNullable<ShellCall['agent']>['session'] | undefined) => unknown): HostShellDefinition {
  const jobs = ctx.get('jobs')
  const parameters: JsonSchemaNode & { properties: Record<string, JsonSchemaNode> } = { ...base.parameters, required: ['description'], properties: {
    ...base.parameters.properties,
    description: { type: 'string', description: 'Required: clear active-voice description of this command, 5–10 words.' },
    timeoutMs: { type: 'number', description: 'Defaults to 120000 ms; capped at 600000 ms. With host jobs, expiry hands the running command to job_output/job_kill; otherwise it stops the command.' },
    ...(jobs ? { run_in_background: { type: 'boolean', description: 'Return a host job id immediately; collect with job_output and stop with job_kill. No execution timeout.' } } : {}),
    sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'After a real denial, request the narrowest wider mode for this exact command with justification. Approval applies only to this call. Do not bypass a rejection.' },
    justification: { type: 'string', description: 'One sentence explaining why this command needs wider access, in the user’s language. Required when changing sandbox_permissions.' },
  } }
  return {
    ...base,
    description: 'Execute a Bash command in a fresh shell using the host sandbox, approvals and jobs. Relative workdir uses the current session workspace. Output is bounded with spill paths. Use command for host-compatible calls; script_path is an OPS extension for an existing script file. Verify resolved absolute targets before delete or move. Never bypass a sandbox denial by switching shells.',
    parameters: { ...parameters },
    // The host validates this value against the declared schema before invoking its renderer.
    output: { schema: HOST_BASH_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderHostBash(value as unknown as HostBashResult) }] },
    async execute(input: unknown, exec: ShellCall = {}): Promise<HostBashResult> {
      let timeoutMs = 120_000
      let policy: ShellPolicy | undefined
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BashArgumentError('invalid arguments: expected an object', 'arguments')
        const args = input as Record<string, unknown>
        const unknown = Object.keys(args).find(key => !Object.hasOwn(parameters.properties, key))
        if (unknown !== undefined) throw new BashArgumentError(`invalid arguments: unknown key ${JSON.stringify(unknown)}; this tool accepts ${Object.keys(parameters.properties).join(', ')}`, unknown)
        if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw new BashArgumentError('invalid run_in_background: expected a boolean', 'run_in_background')
        const { run_in_background, sandbox_permissions, justification, ...local } = args
        if (local.timeoutMs !== undefined && (typeof local.timeoutMs !== 'number' || !Number.isFinite(local.timeoutMs) || local.timeoutMs <= 0)) throw new BashArgumentError('invalid timeoutMs: expected a positive finite number', 'timeoutMs')
        timeoutMs = Math.min(local.timeoutMs ?? 120_000, HOST_MAX_BASH_TIMEOUT_MS)
        local.timeoutMs = timeoutMs
        local.workdir = resolveWorkdir(local, exec.agent?.session)
        // Pure validation occurs before approval, job admission or physical preparation.
        base.resolve(local)
        if (typeof args.description !== 'string' || !args.description.trim()) throw new BashArgumentError('invalid description: expected a non-empty string', 'description')
        if (!exec.agent?.session?.id) return hostFailure('EXECUTOR_UNAVAILABLE: an authoritative session is required.', timeoutMs)
        const standing = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session })
        if (!standing || !['read-only', 'workspace-write', 'danger-full-access'].includes(standing.mode)) return hostFailure('EXECUTOR_UNAVAILABLE: authoritative session policy is unavailable.', timeoutMs)
        policy = await approveBashPolicy(ctx, args, exec, standing)
        exec.signal?.throwIfAborted()
        const dshEnv = ctx.get('shellEnv')?.collect(exec) ?? {}
        const approvedPolicy = policy
        const start: StartShell = (execution, options) => createExecution(local, execution, standing, approvedPolicy, dshEnv, options)
        if (jobs && ctx.get('jobs') === jobs) {
          let attached
          try { attached = startBashJob(jobs, args as { command?: string; script_path?: string }, exec, start) }
          catch (error) {
            if (run_in_background) throw error
            ctx.logger?.warn?.(`Bash job admission refused; using the foreground deadline: ${errorMessage(error)}`)
          }
          if (attached) return run_in_background ? { kind: 'background', jobId: attached.id } : await waitOnBashJob(jobs, attached, exec, timeoutMs)
        } else if (run_in_background) return hostFailure('EXECUTOR_UNAVAILABLE: the host job registry is unavailable.', timeoutMs)
        return hostForeground(await (await start(exec, {})).result())
      } catch (error) {
        if (isBashArgumentError(error)) throw error
        return { ...hostFailure(errorMessage(error), timeoutMs), ...(exec.signal?.aborted ? { aborted: true, cancelled: true } : {}), ...(policy ? { sandbox: { mode: policy.mode, denied: false } } : {}) }
      }
    },
  } satisfies ToolDefinition
}
