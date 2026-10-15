/** Prepare the host's Windows ACL prerequisite before native or PTC execution.
 * No monkey-patching host services; only the selected, owned workspace gains
 * directory-only WRITE_OWNER. The DSH provider still owns confinement/grants.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const script = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const pending = new Map()
const prepared = new Set()
export function prepareWorkspace(policy, { platform = process.platform, run = runPreparation } = {}) {
  if (platform !== 'win32' || policy?.mode !== 'workspace-write') return Promise.resolve()
  if (!path.isAbsolute(policy.workspaceRoot ?? '')) return Promise.reject(new Error('Invalid authoritative workspace root'))
  const root = fs.realpathSync.native(policy.workspaceRoot)
  // Do not silently resolve a link selected as the authority root.
  if (path.normalize(root).toLowerCase() !== path.resolve(policy.workspaceRoot).toLowerCase()) {
    return Promise.reject(new Error('Workspace root must not resolve through a junction or symlink'))
  }
  if (prepared.has(root)) return Promise.resolve()
  if (!pending.has(root)) {
    const work = Promise.resolve().then(() => run(root)).then(() => { prepared.add(root) }).finally(() => { pending.delete(root) })
    pending.set(root, work)
  }
  return pending.get(root)
}
/** Safety net only: the root DACL write no longer scales with workspace size (#43). */
export const PREPARATION_TIMEOUT_MS = 120_000
const FAILED = 'DSH workspace preparation failed'
// Locale-independent markers PowerShell prints when execution policy refuses a script file.
const EXECUTION_POLICY = /about_Execution_Policies|UnauthorizedAccess|PSSecurityException/i
// bin/prepare-workspace.ps1's own refusals, plus a denied DACL write: the folder lacks the prerequisite.
const PREREQUISITE = /not owned by the current user|reparse point|Explicit effective denial of WRITE_OWNER|is not a directory|WRITE_OWNER verification failed|Access is denied|0x80070005/i
/** Name the cause of a failed preparation run, so a policy, a folder and an executor problem read differently (#66). */
export function classifyPreparationFailure(output, { root, script: file = script } = {}) {
  const tail = output.trim() || '(no output)'
  if (EXECUTION_POLICY.test(output)) {
    return `PowerShell execution policy blocked dsh-ops's own preparation script ${file} even with -ExecutionPolicy Bypass, so the policy comes from Group Policy (MachinePolicy/UserPolicy). Ask an administrator, check \`powershell.exe -NoProfile -Command Get-ExecutionPolicy -List\`, or use danger-full-access for this session (it skips preparation). Output: ${tail}`
  }
  if (PREREQUISITE.test(output)) {
    const reason = output.split(/\r?\n/).map(line => line.trim()).find(line => PREREQUISITE.test(line)) ?? tail
    return `the workspace root ${root} does not meet the sandbox prerequisite (the host needs WRITE_OWNER on it): ${reason.replace(/\.?$/, '.')} Fix the folder's owner or permissions, open a workspace you own, or use danger-full-access. This is a folder permission problem, not a DSH authorization denial.`
  }
  return undefined
}
export function runPreparation(root, { executable, args, timeoutMs = PREPARATION_TIMEOUT_MS } = {}) {
  const windows = process.env.SystemRoot ?? 'C:\\Windows'
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const backups = path.join(home, 'dsh-ops/acl-backups')
  executable ??= path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  // Our own trusted bootstrap: execution policy is no security boundary for it, and the Windows
  // client default (Restricted) would otherwise block every shell tool (#66). Group Policy still wins.
  args ??= ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Workspace', root, '-BackupDir', backups]
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-2048) })
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2048) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(new Error(`${FAILED}: the preparation executor could not start ${executable}: ${error.message}`)) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) return resolve()
      // Never end the message at the colon: a killed child has written nothing yet.
      const detail = timedOut
        ? `the preparation executor timed out after ${timeoutMs} ms preparing ${root}; the workspace ACL state is unknown and the backup receipt is under ${backups}.`
        : classifyPreparationFailure(`${stderr}\n${stdout}`, { root })
          ?? `exited with ${code === null ? `signal ${signal}` : `code ${code}`} after ${Date.now() - started} ms preparing ${root}: ${stderr.trim() || stdout.trim() || '(no output)'}`
      reject(new Error(`${FAILED}: ${detail}`))
    })
  })
}
export function mountWorkspacePreparation(root) {
  if (process.platform !== 'win32') return
  root.inject(['sandboxPolicy', 'tools'], ctx => {
    // Execute-stage hook: user approval/guards have already accepted the call.
    ctx.on('tools/execute', async (exec, next) => {
      const session = exec?.agent?.session
      if (session && ['run_code', 'pwsh', 'bash', 'pwsh_persistent', 'bash_persistent'].includes(exec.name)) {
        await prepareWorkspace(ctx.get('sandboxPolicy').resolve({ session }))
      }
      return next()
    })
  })
}
