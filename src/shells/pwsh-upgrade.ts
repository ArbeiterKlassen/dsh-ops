/** Operator action for the standard host PowerShell install; never an automatic plugin activation. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { errorMessage } from './types.js'

export const HOST_PWSH_UPGRADE_GUIDANCE = 'Installs or upgrades the standard PowerShell 7 installation on Windows through WinGet. Restart DSH afterwards. An explicit host pwshPath is preserved and must be reviewed in host settings if it points elsewhere. Existing Windows PowerShell 5.1 and OPS provisioned files are not removed.'
export interface PwshUpgradePlan {
  supported: boolean
  file?: string
  args: readonly string[]
  guidance: string
  unavailable?: string
}
export interface UpgradeProcessResult { started: boolean; exitCode: number | null; signal: string | null; error?: string }
export type UpgradeRunner = (plan: PwshUpgradePlan & { file: string }, signal?: AbortSignal) => Promise<UpgradeProcessResult>
export interface PwshUpgradeResult {
  status: 'preview' | 'unavailable' | 'completed' | 'no-update' | 'failed' | 'cancelled'
  effectState: 'none' | 'applied' | 'unknown'
  plan: PwshUpgradePlan
  exitCode?: number | null
  signal?: string | null
  error?: string
}
const usable = (file: string): boolean => {
  try { const stat = fs.lstatSync(file); return stat.isFile() || stat.isSymbolicLink() } catch { return false }
}

/** Use an absolute executable, never a command shell or a relative PATH entry. */
export function hostPwshUpgradePlan({ platform = process.platform, env = process.env }: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): PwshUpgradePlan {
  // Microsoft Learn recommends this exact stable package; install also upgrades an existing install.
  const args = ['install', '--id', 'Microsoft.PowerShell', '--exact', '--source', 'winget', '--installer-type', 'wix']
  const base = { supported: false, args, guidance: HOST_PWSH_UPGRADE_GUIDANCE }
  if (platform !== 'win32') return { ...base, unavailable: 'This action is Windows-only. Manage host PowerShell through your operating system package manager.' }
  const candidates = [
    ...(env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? [path.join(env.LOCALAPPDATA, 'Microsoft/WindowsApps/winget.exe')] : []),
    ...(env.PATH ?? env.Path ?? '').split(';').map(entry => entry.trim().replace(/^"|"$/g, ''))
      .filter(entry => path.isAbsolute(entry)).map(entry => path.join(entry, 'winget.exe')),
  ]
  const file = candidates.find(usable)
  return file ? { ...base, supported: true, file: path.resolve(file) }
    : { ...base, unavailable: 'WinGet is unavailable. Install or repair Microsoft App Installer, or use the official PowerShell installer; no installation was attempted.' }
}

/** CLI runner. A host UI may supply its subprocess runner and expose the installer interaction there. */
export const runUpgradeProcess: UpgradeRunner = (plan, signal) => new Promise(resolve => {
  let started = false, failure: string | undefined
  const child = spawn(plan.file, [...plan.args], { stdio: 'inherit', windowsHide: true, shell: false, signal })
  child.once('spawn', () => { started = true })
  child.once('error', error => { failure = errorMessage(error) })
  child.once('close', (exitCode, closedSignal) => resolve({ started, exitCode, signal: closedSignal, ...(failure ? { error: failure } : {}) }))
})

/** Cancellation stops the runner; an already-started installer may have effects and is never called rolled back. */
export async function upgradeHostPwsh({ execute = false, dryRun = false, signal, runner = runUpgradeProcess,
  platform, env }: { execute?: boolean; dryRun?: boolean; signal?: AbortSignal; runner?: UpgradeRunner; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<PwshUpgradeResult> {
  const plan = hostPwshUpgradePlan({ platform, env })
  if (signal?.aborted) return { status: 'cancelled', effectState: 'none', plan }
  if (!plan.supported || !plan.file) return { status: 'unavailable', effectState: 'none', plan }
  if (!execute || dryRun) return { status: 'preview', effectState: 'none', plan }
  let result: UpgradeProcessResult
  try { result = await runner({ ...plan, file: plan.file }, signal) }
  catch (error) { return { status: signal?.aborted ? 'cancelled' : 'failed', effectState: 'unknown', error: errorMessage(error), plan } }
  const facts = { plan, exitCode: result.exitCode, signal: result.signal, ...(result.error ? { error: result.error } : {}) }
  if (signal?.aborted || result.signal) return { ...facts, status: 'cancelled', effectState: result.started ? 'unknown' : 'none' }
  if (result.error || !result.started) return { ...facts, status: 'failed', effectState: result.started ? 'unknown' : 'none' }
  if (result.exitCode === 0) return { ...facts, status: 'completed', effectState: 'applied' }
  // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE, from Microsoft's WinGet HRESULT definitions.
  // This says no applicable update, not that a custom pwshPath or every installed copy is current.
  if (result.exitCode !== null && (result.exitCode >>> 0) === 0x8a15002b) return { ...facts, status: 'no-update', effectState: 'none' }
  return { ...facts, status: 'failed', effectState: 'unknown' }
}
