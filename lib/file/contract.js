import { publicToolName, FILE_TOOLS, FILE_MUTATIONS } from '../policy.js'

const string = { type: 'string' }
const integer = { type: 'integer', minimum: 0 }
const bounded = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

export { FILE_TOOLS }
const revision = { type: 'string', pattern: '^(absent|[a-f0-9]{64})$', description: 'SHA-256 revision returned by inspect/stat; absent is create-only, never an overwrite wildcard.' }
const existingRevision = { ...revision, pattern: '^[a-f0-9]{64}$' }

export const PARAMETERS = Object.freeze({
  inspect_local_file: bounded({
    path: string,
    offset: { ...integer, minimum: 1 },
    limit: { ...integer, minimum: 1, maximum: 10000 },
    encoding: { type: 'string', enum: ['utf-8'] },
    view: { type: 'string', enum: ['text', 'hex'] },
  }),
  glob: bounded({
    path: string,
    pattern: { type: 'array', minItems: 1, items: string },
    outputMode: { type: 'string', enum: ['paths', 'details'] },
    sort: { type: 'string', enum: ['path', 'modified'] },
    offset: integer,
    limit: { ...integer, minimum: 1, maximum: 10000 },
  }, ['pattern']),
  grep: bounded({
    path: string,
    pattern: string,
    glob: { type: 'array', items: string },
    outputMode: { type: 'string', enum: ['files_with_matches', 'content', 'count', 'summary'] },
    caseInsensitive: { type: 'boolean' },
    lineNumbers: { type: 'boolean' },
    beforeContext: { ...integer, maximum: 32 },
    afterContext: { ...integer, maximum: 32 },
    multiline: { type: 'boolean' },
    offset: integer,
    limit: { ...integer, minimum: 1, maximum: 10000 },
  }, ['pattern']),
  stat: bounded({ path: string }, ['path']),
  diff: bounded({ path: string, content: string, offset: integer, limit: { ...integer, minimum: 1, maximum: 1000 } }, ['path', 'content']),
  write_file: bounded({ path: string, content: string, expectedRevision: revision, dryRun: { type: 'boolean' } }, ['path', 'content', 'expectedRevision']),
  edit_file: bounded({ path: string, expectedRevision: existingRevision, edits: { type: 'array', minItems: 1, maxItems: 100, items: bounded({ oldText: { ...string, minLength: 1 }, newText: string }, ['oldText', 'newText']) }, dryRun: { type: 'boolean' } }, ['path', 'expectedRevision', 'edits']),
  copy: bounded({ path: string, to: string, expectedRevision: existingRevision }, ['path', 'to', 'expectedRevision']),
  move: bounded({ path: string, to: string, expectedRevision: existingRevision }, ['path', 'to', 'expectedRevision']),
  remove: bounded({ path: string, expectedRevision: existingRevision }, ['path', 'expectedRevision']),
  replace: bounded({
    path: string,
    pattern: string,
    replacement: string,
    glob: { type: 'array', items: string },
    maxReplacements: { ...integer, minimum: 1, maximum: 100000 },
    dryRun: { type: 'boolean' },
  }, ['pattern', 'replacement']),
})

export const OUTPUT = {
  type: 'object',
  properties: {
    revision: string, bytes: { type: 'integer' }, lineCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    status: { type: 'string' }, phase: { type: 'string' }, changed: { type: 'integer' },
    matched: { type: 'integer' }, skipped: { type: 'integer' }, failed: { type: 'integer' },
    complete: { type: 'boolean' }, omitted: { type: 'integer' }, total: { type: 'integer' },
    nextOffset: { type: 'integer' }, truncated: { type: 'boolean' }, items: { type: 'array', items: {} },
    dryRun: { type: 'boolean' }, files: { type: 'integer' }, matches: { type: 'integer' },
    error: { type: 'object' },
  },
}

// Failures are returned values, never thrown: a try/catch alone misses them (#44).
const RESULT = ' Failures resolve as {status:"error"|"rejected", error.code}; they are not thrown.'
export const DESCRIPTIONS = Object.freeze({
  inspect_local_file: 'Read bounded UTF-8 text lines or a hex view from path relative to the DSH session cwd. Directories are rejected; use ops_glob or ops_grep.' + RESULT,
  glob: 'Find regular files below path. pattern is an ARRAY of globs matched against paths relative to path, e.g. ["**/*.md","!vendor/**"]: "*.md" matches the top level only, "!" excludes, at least one positive entry. Symlinks, reparse points, hidden files and .git are not traversed.' + RESULT,
  grep: 'Search UTF-8 files below path. pattern is ONE Rust regex string; filter files with glob, an ARRAY of the same relative globs ("!" excludes). There is no include field. Bounded output, paging and optional line context.' + RESULT,
  stat: 'Inspect one regular file: SHA-256 revision, bytes, UTF-8 lineCount (null for binary), timestamps and permissions; no content. Missing paths return exists:false, revision:absent.' + RESULT,
  diff: 'Read-only comparison of one UTF-8 file with content. Returns one prefix/suffix-trimmed replacement hunk (not a minimal diff), paged 0-based offset/limit (default 100). Includes old/new hashes and line counts; no publication.' + RESULT,
  write_file: 'Create or fully overwrite one UTF-8 file; parents must exist. Required expectedRevision is the observed SHA-256, or absent for create-only. Atomic CAS, short receipt with new revision/bytes/lineCount; dryRun only previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Read-only denies even dryRun. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
  edit_file: 'Precisely patch one UTF-8 file using 1-100 oldText/newText edits against the SAME original bytes. Every nonempty oldText must occur exactly once; overlapping edits reject all. Required expectedRevision from inspect/stat. Atomic CAS; dryRun previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Preserve CRLF/BOM explicitly in text. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
  copy: 'Copy ONE regular file to absent to (relative to session cwd); parents must exist. Required expectedRevision checks source. Atomic no-clobber destination; preserves metadata or fails closed. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved. Darwin requires APFS cloning and currently refuses nonempty extended ACLs with METADATA_UNSUPPORTED before staging; use a dedicated metadata-aware tool for ACL-bearing files. No directories/links; recursive work uses ops_batch when available.' + RESULT,
  move: 'Move ONE regular file to absent to, same filesystem only. Required source expectedRevision. Atomic no-clobber destination then source unlink; failures after publication carry effectState:applied. No copy-delete fallback, directories or links.' + RESULT,
  remove: 'Unlink ONE regular file with required expectedRevision from inspect/stat. No recursion/directories/links. Atomic unlink; no trash. Read-only denies all mutations.' + RESULT,
  replace: 'Replace LITERAL text (pattern is not a regex) in UTF-8 files under path; glob filters files as in ops_grep. dryRun observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
})

/** Drop unused empty placeholders strict adapters send for optional fields; never mutate the caller's object. */
export function normalizeArguments(rawName, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const schema = PARAMETERS[rawName]
  if (!schema) return { ...args }
  const required = new Set(schema.required)
  const result = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const field = schema.properties[key]
    if (field && !required.has(key)) {
      if (field.type === 'string' && typeof value === 'string' && value.trim() === '') continue
      if (field.type === 'array' && Array.isArray(value) && value.length === 0) continue
    }
    result[key] = value
  }
  return result
}

export function definition(rawName, execute) {
  return {
    name: publicToolName(rawName),
    description: DESCRIPTIONS[rawName],
    parameters: PARAMETERS[rawName],
    ...(!FILE_MUTATIONS.includes(rawName) ? { isConcurrencySafe: () => true } : {}),
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}
