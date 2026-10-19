/** Reviewed alternatives for explicit per-tool selection.
 * These retain bounded read/search functionality and OPS permission checks,
 * not the host argument/return shape or identical search coverage. In particular
 * OPS glob excludes hidden/link/reparse traversal and takes relative glob arrays.
 * See the paired component references before opting into a different workflow.
 */
import { publicToolName } from './policy.js'
import { componentEnabled } from './components/defaults.js'

// Only reviewed, implemented replacements belong here. A similarly named ops_*
// registration is NOT evidence of equivalent capability. In particular replace
// cannot stand in for write/edit, and background jobs cannot control host jobs.
export const OFFICIAL_REPLACEMENTS = Object.freeze({
  read: publicToolName('inspect_local_file'),
  glob: publicToolName('glob'),
  grep: publicToolName('grep'),
})

export type OfficialReplacement = keyof typeof OFFICIAL_REPLACEMENTS

export function platformSurface(platform: string = process.platform) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unsupported official-tool hiding platform: ${platform}`)
  return { retainedCommand: platform === 'win32' ? 'pwsh' : 'bash', shellDefaultEnabled: componentEnabled('shell', platform) }
}
