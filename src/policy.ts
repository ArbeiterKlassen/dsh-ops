import { FILE_TOOLS, NATIVE_FILE_TOOLS, IN_PROCESS_TOOLS } from './capabilities/registry.js'
export { FILE_TOOLS, FILE_MUTATIONS, IN_PROCESS_TOOLS } from './capabilities/registry.js'

/** Model-facing routing, kept in one section. No shared registry mutation. */
export const TOOLING_SECTION = 'dsh-ops:repository-tooling'
// Legacy section name kept for consumers; the plugin no longer publishes it.
export const HOST_SHELL_SECTION = 'dsh-ops:host-shell-policy'
export const SECTION_ORDERS = Object.freeze({ [TOOLING_SECTION]: 3250 })
export const TOOL_PREFIX = 'ops_'
// The plugin's second layer executes POSIX commands; pwsh7 uses the host tool.
export function publicToolName(rawName: string) { return `${TOOL_PREFIX}${rawName}` }
export const BASH_TOOL = publicToolName(IN_PROCESS_TOOLS[0])

/** Resolve the actual command capability, not the presence of a shell executable. */
export function ladderLevels({ published, pwsh = false }: { published: Iterable<string>, pwsh?: boolean }) {
  const names = new Set(published)
  return {
    files: NATIVE_FILE_TOOLS.some(name => names.has(publicToolName(name))),
    bash: names.has(BASH_TOOL),
    pwsh: pwsh === true && names.has('pwsh'),
  }
}

interface ToolingPolicyOptions {
  published?: Iterable<string>
  mounted?: boolean
  levels?: { files?: boolean, bash?: boolean, pwsh?: boolean }
  pwsh7?: boolean
  shellComponent?: boolean
  extraGuidance?: string
}

/** A single compact table; absent tools never get advertised. */
export function renderToolingPolicy({ published, mounted, levels, pwsh7 = false, shellComponent = true, extraGuidance = '' }: ToolingPolicyOptions) {
  const names = new Set(published ?? (mounted || levels?.files
    ? [...NATIVE_FILE_TOOLS, ...(levels?.bash ? IN_PROCESS_TOOLS : [])].map(publicToolName) : []))
  if (levels?.pwsh) names.add('pwsh')
  if (!shellComponent) names.delete('pwsh')
  const hasFiles = NATIVE_FILE_TOOLS.some(name => names.has(publicToolName(name)))
  const hasBash = names.has(BASH_TOOL)
  const hasPwsh = shellComponent && names.has('pwsh')
  if (!hasFiles && !hasBash && !hasPwsh) return ''
  const heading = hasBash ? '# Shell routing: bash → PowerShell 7'
    : hasFiles ? '# Repository file tools' : '# Windows-native shell'
  const lines = [heading, '', '| Task | Tool |', '| --- | --- |']
  const row = (raw: string, task: string) => {
    if (names.has(publicToolName(raw))) lines.push(`| ${task} | ${publicToolName(raw)} |`)
  }
  row('read_many', 'Read UTF-8 ranges from multiple files')
  row('edit_many', 'Atomic original-text edits in one file (CAS)')
  row('inspect_local_file', 'Bounded UTF-8 lines / hex')
  if (hasFiles && names.has('read_image')) lines.push('| Images | read_image (host) |')
  row('grep', 'Search contents')
  row('glob', 'Find paths')
  row('replace', 'Batch literal replacement')
  row('write_file', 'Create / full UTF-8 write (CAS)')
  row('edit_file', 'Precise original-text patch (CAS)')
  row('diff', 'Preview proposed UTF-8 content')
  row('stat', 'Revision / bytes / line count / metadata')
  row('copy', 'Copy one regular file, no clobber')
  row('move', 'Move one regular file, same filesystem')
  row('remove', 'Remove one regular file (CAS)')
  row('result', 'Page / release owned result references')
  row('bash', 'General commands / builds / git / pipelines / scripts — preferred command executor')
  if (names.has('pwsh')) lines.push(`| Windows-native cmdlets / registry / services only | pwsh (${pwsh7 || levels?.pwsh ? 'bundled PowerShell 7 via host' : 'host PowerShell'}) |`)
  lines.push('', '- ops_* arguments are strict: pass only declared fields.')
  if (hasFiles) lines.push('- Use file tools for file operations and batch independent requests.')
  if (names.has(publicToolName('grep'))) lines.push('- ops_grep: summary for aggregate file/match totals; count for per-file counts; content for matching text. Follow nextOffset for remaining pages, but do not loop blindly on truncated/failed scans: they are not exhaustive.')
  if (hasFiles) lines.push(
    '- Single-file tools use `path`, resolved relative to the current DSH session cwd. `to` on copy/move uses the same base. Use `/` separators; do not pass workspace, cwd, or file_path aliases. ops_result accepts the original reference root; read_many takes files.',
    '- Native file tools are UTF-8 first and bounded. glob and grep do not traverse symlinks, junctions, reparse points, hidden files, or `.git`.',
  )
  const globbing = ['glob', 'grep', 'replace'].filter(raw => names.has(publicToolName(raw)))
  if (globbing.length) {
    const arrays = [names.has(publicToolName('glob')) && 'ops_glob `pattern`', (names.has(publicToolName('grep')) || names.has(publicToolName('replace'))) && 'the `glob` filters'].filter(Boolean).join(' and ')
    const notes = [names.has(publicToolName('grep')) && 'ops_grep has no `include`', names.has(publicToolName('replace')) && 'ops_replace `pattern` is literal text'].filter(Boolean)
    lines.push(`- ${arrays} ${arrays.includes(' and ') ? 'are ARRAYS' : 'is an ARRAY'} of globs relative to \`path\`, e.g. \`["**/*.md","!vendor/**"]\`; \`*.md\` matches the top level only.${notes.length ? ` ${notes.join('; ')}.` : ''}`)
  }
  if (hasFiles) lines.push('- ops file tools never throw: check `status` and `error.code`/`error.nextAction`; a try/catch alone misses their failures.')
  if (names.has(publicToolName('write_file')) || names.has(publicToolName('edit_file'))) lines.push('- Read/stat first; reuse SHA-256 `revision` as `expectedRevision` (write create-only: `absent`). Receipts include new hash, bytes and lineCount; Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved. Unsupported metadata is not a permission escalation. Edit hunks target the same original and must be unique/nonoverlapping; CRLF/BOM are literal.')
  if (hasFiles) lines.push('- Follow error.nextAction; authorization denials require the user to change mode, not retries. After applied/unknown effects inspect postconditions; do not switch to a shell workaround.')
  if (names.has(BASH_TOOL)) lines.push('- Prefer bash for command execution. Use PowerShell only when Windows-native functionality is necessary; fix bash errors in bash, do not switch shells or mix their syntax.',
    '- Use command only for short commands and pipelines. For scripts longer than about 1 KB or containing heredocs, quotes, backslashes or non-ASCII text, write the script to a file first and pass script_path.',
    '- ops_bash resolves with `status` (completed/failed), `exitCode`, stdout/stderr, `error` and `permission`; it throws only for invalid arguments or an unavailable executor.')
  if (extraGuidance.trim()) lines.push('', extraGuidance.trim())
  return lines.join('\n')
}

/** Legacy API: no second prompt section. */
export function renderHostShellPolicy() { return '' }

/** Explicit deny policy applies even without an ops command capability. */
export function hostShellEnforcement({ shellPolicy }: { shellPolicy?: string }) {
  return { hide: shellPolicy === 'deny-host-shell', reason: undefined }
}
export function hostShellRefusal({ toolName, denied }: { toolName: string, denied: ReadonlySet<string> }) {
  if (!denied.has(toolName)) return undefined
  return { kind: 'deny', reason: `Host tool ${toolName} is disabled by dsh-ops shellPolicy. Use an available file tool for file operations; otherwise request an operator policy change.` }
}
