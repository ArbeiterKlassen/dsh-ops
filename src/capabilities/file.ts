/** File capability data; no host services or registration side effects. */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ParameterSchema } from './types.js'

const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer', description: 'Nonnegative integer (0-based).' }
const range = (min: number, max: number, description = ''): JsonSchemaNode => ({ type: 'integer', description: `${min}-${max} inclusive.${description ? ` ${description}` : ''}` })
const bounded = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })

// The pinned host SDK supports a schema subset: express bounds in descriptions;
// the native worker remains authoritative for validation, including raw PTC calls.
const revision: JsonSchemaNode = { type: 'string', description: '64 lowercase hex SHA-256 revision returned by inspect/stat; absent is create-only, never an overwrite wildcard.' }
const existingRevision: JsonSchemaNode = { type: 'string', description: '64 lowercase hex SHA-256 revision returned by inspect/stat; absent is not accepted.' }

const edits = bounded({ path: string, expectedRevision: existingRevision, edits: { type: 'array', description: '1-100 nonoverlapping edits against the same original bytes.', items: bounded({ oldText: { ...string, description: 'Nonempty text that occurs exactly once in the original.' }, newText: string }, ['oldText', 'newText']) }, dryRun: { type: 'boolean' } }, ['path', 'expectedRevision', 'edits'])

export const PARAMETERS = Object.freeze({
  read_many: bounded({ files: { type: 'array', description: '1-32 UTF-8 file ranges.', items: bounded({
    path: string, offset: { type: 'integer', description: '1-based line; minimum 1, default 1.' }, limit: range(1, 10000, 'Default 200.'),
  }, ['path']) } }, ['files']),
  edit_many: edits,
  inspect_local_file: bounded({
    path: string,
    offset: { type: 'integer', description: '1-based line or 16-byte hex row; default 1. Legacy 0 also reads the first unit.' },
    limit: range(1, 10000, 'Default 200.'),
    encoding: { type: 'string', enum: ['utf-8'] },
    view: { type: 'string', enum: ['text', 'hex'] },
  }),
  glob: bounded({
    path: string,
    pattern: { type: 'array', description: 'At least one positive glob is required.', items: string },
    outputMode: { type: 'string', enum: ['paths', 'details'] },
    sort: { type: 'string', enum: ['path', 'modified'] },
    offset: integer,
    limit: range(1, 10000, 'Default 100.'),
  }, ['pattern']),
  grep: bounded({
    path: string,
    pattern: string,
    glob: { type: 'array', items: string },
    outputMode: { type: 'string', enum: ['files_with_matches', 'content', 'count', 'summary'] },
    caseInsensitive: { type: 'boolean' },
    lineNumbers: { type: 'boolean' },
    beforeContext: range(0, 32),
    afterContext: range(0, 32),
    multiline: { type: 'boolean' },
    offset: integer,
    limit: range(1, 10000, 'Default 100.'),
  }, ['pattern']),
  stat: bounded({ path: string }, ['path']),
  diff: bounded({ path: string, content: string, offset: integer, limit: range(1, 1000, 'Default 100.') }, ['path', 'content']),
  write_file: bounded({ path: string, content: string, expectedRevision: revision, dryRun: { type: 'boolean' } }, ['path', 'content', 'expectedRevision']),
  edit_file: edits,
  copy: bounded({ path: string, to: string, expectedRevision: existingRevision }, ['path', 'to', 'expectedRevision']),
  move: bounded({ path: string, to: string, expectedRevision: existingRevision }, ['path', 'to', 'expectedRevision']),
  remove: bounded({ path: string, expectedRevision: existingRevision }, ['path', 'expectedRevision']),
  replace: bounded({
    path: string,
    pattern: string,
    replacement: string,
    glob: { type: 'array', items: string },
    maxReplacements: range(1, 100000, 'Default 100.'),
    dryRun: { type: 'boolean' },
  }, ['pattern', 'replacement']),
})

export const OUTPUT: JsonSchemaNode = {
  type: 'object',
  properties: {
    revision: string, bytes: { type: 'integer' }, lineCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    status: { type: 'string' }, phase: { type: 'string' }, changed: { type: 'integer' },
    matched: { type: 'integer' }, skipped: { type: 'integer' }, failed: { type: 'integer' },
    complete: { type: 'boolean' }, omitted: { type: 'integer' }, total: { type: 'integer' },
    nextOffset: { type: 'integer' }, truncated: { type: 'boolean' }, items: { type: 'array', items: {} },
    dryRun: { type: 'boolean' }, files: { type: 'integer' }, matches: { type: 'integer' },
    skippedFiles: { type: 'integer' },
    error: { type: 'object' },
  },
}

export const READ_MANY_OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    status: string, complete: { type: 'boolean' }, nextIndex: { type: 'integer' }, pending: { type: 'integer' },
    total: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, effectState: string,
    items: { type: 'array', items: { ...OUTPUT, properties: { ...OUTPUT.properties, path: string } } }, error: { type: 'object' },
  },
}

// Failures are returned values, never thrown: a try/catch alone misses them (#44).
const RESULT = ' Failures resolve as {status:"error"|"rejected", error.code}; they are not thrown.'
const EDIT_DESCRIPTION = 'Precisely patch one UTF-8 file using 1-100 oldText/newText edits against the SAME original bytes. Every nonempty oldText must occur exactly once; overlapping edits reject all. Required expectedRevision from inspect/stat. Atomic CAS; dryRun previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Preserve CRLF/BOM explicitly in text. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT
export const DESCRIPTIONS = Object.freeze({
  read_many: 'Read UTF-8 ranges in one call. Paths use the current session cwd. Check each file complete/error; nextOffset continues its lines, nextIndex only resumes pending files. Binary data requires a binary reader.' + RESULT,
  inspect_local_file: 'Read bounded UTF-8 text lines or a hex view from path relative to the DSH session cwd. Directories are rejected; use ops_glob or ops_grep.' + RESULT,
  glob: 'Find regular files below path. pattern is an ARRAY of globs matched against paths relative to path, e.g. ["**/*.md","!vendor/**"]: "*.md" matches the top level only, "!" excludes, at least one positive entry. Symlinks, reparse points, hidden files and .git are not traversed.' + RESULT,
  grep: 'Search UTF-8 files below path. pattern is ONE Rust regex string; filter files with glob, an ARRAY of the same relative globs ("!" excludes). There is no include field. Use summary for aggregate file/match totals, count for per-file counts, content for matching text (default); limit defaults to 100 items. Paging uses 0-based offset/nextOffset. Follow nextOffset until complete:true, but do not loop blindly on truncated/failed scans. Totals cover scanned readable UTF-8 files within file-size limits; truncated scans are not exhaustive. Each page rescans candidates to count totals while materializing only its requested window. Optional line context.' + RESULT,
  stat: 'Inspect one regular file: SHA-256 revision, bytes, UTF-8 lineCount (null for binary), timestamps and permissions; no content. Missing paths return exists:false, revision:absent.' + RESULT,
  diff: 'Read-only comparison of one UTF-8 file with content. Returns one prefix/suffix-trimmed replacement hunk (not a minimal diff), paged 0-based offset/limit (default 100). Includes old/new hashes and line counts; no publication.' + RESULT,
  write_file: 'Create or fully overwrite one UTF-8 file; parents must exist. Required expectedRevision is the observed SHA-256, or absent for create-only. Atomic CAS, short receipt with new revision/bytes/lineCount; dryRun only previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Read-only denies even dryRun. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
  edit_file: EDIT_DESCRIPTION,
  edit_many: EDIT_DESCRIPTION,
  copy: 'Copy ONE regular file to absent to (relative to session cwd); parents must exist. Required expectedRevision checks source. Atomic no-clobber destination; preserves metadata or fails closed. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved. Darwin requires APFS cloning and currently refuses nonempty extended ACLs with METADATA_UNSUPPORTED before staging; use a dedicated metadata-aware tool for ACL-bearing files. No directories/links; recursive work uses ops_batch when available.' + RESULT,
  move: 'Move ONE regular file to absent to, same filesystem only. Required source expectedRevision. Atomic no-clobber destination then source unlink; failures after publication carry effectState:applied. No copy-delete fallback, directories or links.' + RESULT,
  remove: 'Unlink ONE regular file with required expectedRevision from inspect/stat. No recursion/directories/links. Atomic unlink; no trash. Read-only denies all mutations.' + RESULT,
  replace: 'Replace LITERAL text (pattern is not a regex) in UTF-8 files under path; glob filters files as in ops_grep. dryRun observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
})
