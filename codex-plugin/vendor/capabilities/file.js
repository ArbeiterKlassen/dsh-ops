import { DOCUMENT_PARAMETERS, DOCUMENT_DESCRIPTIONS, documentOutput } from './documents.js';
import { STORAGE_REFERENCE } from './result.js';
const string = { type: 'string' };
const integer = { type: 'integer', description: 'Nonnegative integer (0-based).' };
const range = (min, max, description = '') => ({ type: 'integer', description: `${min}-${max} inclusive.${description ? ` ${description}` : ''}` });
const bounded = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
// The pinned host SDK supports a schema subset: express bounds in descriptions;
// the native worker remains authoritative for validation, including raw PTC calls.
const revision = { type: 'string', description: '64 lowercase hex SHA-256 revision returned by inspect/stat; absent is create-only, never an overwrite wildcard.' };
const existingRevision = { type: 'string', description: '64 lowercase hex SHA-256 revision returned by inspect/stat; absent is not accepted.' };
const edits = bounded({ path: string, expectedRevision: existingRevision, edits: { type: 'array', description: '1-100 nonoverlapping edits against the same original bytes.', items: bounded({ oldText: { ...string, description: 'Nonempty text that occurs exactly once in the original.' }, newText: string }, ['oldText', 'newText']) }, dryRun: { type: 'boolean' } }, ['path', 'expectedRevision', 'edits']);
export const PARAMETERS = Object.freeze({
    ...DOCUMENT_PARAMETERS,
    read_files: bounded({ files: { type: 'array', description: '1-32 file ranges.', items: bounded({
                path: string, offset: { type: 'integer', description: 'Line >=1; default 1.' }, limit: range(1, 10000, 'Default 200.'),
            }, ['path']) } }, ['files']),
    inspect_local_file: bounded({
        path: string,
        offset: { type: 'integer', description: '1-based line or 16-byte hex row; default 1. Legacy 0 also reads the first unit.' },
        limit: range(1, 10000, 'Default 200.'),
        encoding: { type: 'string', enum: ['utf-8'] },
        view: { type: 'string', enum: ['text', 'hex'] },
    }),
    json_query: bounded({
        path: string,
        selector: { type: 'string', description: 'Optional bounded selector. Empty means root. Supports properties and numeric indexes, for example [1522].list or events[196].pages[0].list.' },
        where: { type: 'object', additionalProperties: true, description: 'Optional equality filter applied to array items. Values may be primitives or nested field paths.' },
        contains: { type: 'string', description: 'Optional case-sensitive substring filter against the compact JSON of each candidate item.' },
        fields: { type: 'array', items: string, description: 'Optional top-level or dotted fields to project from each result.' },
        offset: integer,
        limit: range(1, 500, 'Default 50.'),
        context: range(0, 10, 'Additional array items before/after each match. Default 0.'),
        maxChars: range(1000, 60000, 'Soft output cap. Default 20000.'),
    }, ['path']),
    glob: bounded({
        path: string,
        pattern: { type: 'array', description: 'At least one positive glob is required.', items: string },
        outputMode: { type: 'string', enum: ['paths', 'details'] },
        sort: { type: 'string', enum: ['path', 'modified'] },
        offset: integer,
        limit: range(1, 10000, 'Default 100.'),
        continuation: { ...string, description: 'Opaque cursor from a complete scan. Keep query options unchanged; omit offset or use nextOffset. SEARCH_STALE requires a fresh query.' },
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
        continuation: { ...string, description: 'Opaque cursor from a complete scan. Keep query options unchanged; omit offset or use nextOffset. SEARCH_STALE requires a fresh query.' },
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
});
export const OUTPUT = {
    type: 'object',
    properties: {
        reference: STORAGE_REFERENCE, referenceRoot: string, root: string, source: { type: 'object' }, storageError: { type: 'object' }, nextAction: string,
        revision: string, bytes: { type: 'integer' }, lineCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        status: { type: 'string' }, phase: { type: 'string' }, changed: { type: 'integer' },
        matched: { type: 'integer' }, skipped: { type: 'integer' }, failed: { type: 'integer' },
        complete: { type: 'boolean' }, omitted: { type: 'integer' }, total: { type: 'integer' },
        nextOffset: { type: 'integer' }, truncated: { type: 'boolean' }, items: { type: 'array', items: {} },
        dryRun: { type: 'boolean' }, files: { type: 'integer' }, matches: { type: 'integer' },
        skippedFiles: { type: 'integer' },
        error: { type: 'object' },
    },
};
export const READ_FILES_OUTPUT = {
    type: 'object', properties: {
        reference: STORAGE_REFERENCE, referenceRoot: string, root: string, source: { type: 'object' }, storageError: { type: 'object' }, nextAction: string,
        status: string, complete: { type: 'boolean' }, nextIndex: { type: 'integer' }, pending: { type: 'integer' },
        total: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, effectState: string,
        items: { type: 'array', items: { ...OUTPUT, properties: { ...OUTPUT.properties, path: string } } }, error: { type: 'object' },
    },
};
export const SEARCH_OUTPUT = {
    ...OUTPUT, properties: {
        ...OUTPUT.properties,
        scanComplete: { type: 'boolean' }, pageComplete: { type: 'boolean' },
        scannedFiles: { type: 'integer' }, skippedFiles: { type: 'integer' },
        skipReasons: { type: 'object' }, matchedObserved: { type: 'integer' },
        matchedTotal: { type: 'integer', description: 'Present only after a complete scan.' },
        truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time', 'row-limit', 'none'] },
        continuation: string, nextAction: string,
    },
};
/** Every projection declares the same canonical execution shape. */
export function fileOutput(rawName) {
    const document = documentOutput(rawName);
    if (document)
        return document;
    if (rawName === 'read_files')
        return READ_FILES_OUTPUT;
    if (rawName === 'glob' || rawName === 'grep')
        return SEARCH_OUTPUT;
    return OUTPUT;
}
// Failures are returned values, never thrown: a try/catch alone misses them (#44).
const RESULT = ' Failures resolve as {status:"error"|"rejected", error.code}; they are not thrown.';
const EDIT_DESCRIPTION = 'Precisely patch one UTF-8 file using 1-100 oldText/newText edits against the SAME original bytes. Every nonempty oldText must occur exactly once; overlapping edits reject all. Required expectedRevision from inspect/stat. Atomic CAS; dryRun previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Preserve CRLF/BOM explicitly in text. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT;
export const DESCRIPTIONS = Object.freeze({
    ...DOCUMENT_DESCRIPTIONS,
    read_files: 'Read UTF-8 ranges relative to session cwd. Check each file complete/error; nextOffset continues lines, nextIndex resumes pending files. Binary needs a binary reader. Failures return status:error|rejected and error.code; never throw.',
    inspect_local_file: 'Read bounded UTF-8 text lines or a hex view from path relative to the DSH session cwd. Directories are rejected; use ops_glob or ops_grep.' + RESULT,
    json_query: 'Read a bounded slice from a potentially large JSON file without putting the whole file in model context. selector accepts property/index paths such as [1522].list or events[196].pages[0].list; where filters array objects by field equality; contains filters by case-sensitive compact-JSON substring; fields projects fields; offset/limit/context bound the output. Defaults: limit 50, context 0, maxChars 20000. The file is parsed inside the adapter, but only the selected bounded excerpt is returned.' + RESULT,
    glob: 'Find regular files below path relative to the current session cwd. pattern is an ARRAY of globs matched against paths relative to path: ["**/*.md","!vendor/**"]; "*.md" matches the top level only, "!" excludes, at least one positive entry. Symlinks, reparse points, hidden files and dependency/build directories are excluded. limit defaults to 100; paging uses 0-based offset/nextOffset. Check scanComplete and pageComplete; matchedTotal exists only after a complete scan. Prefer continuation with unchanged options; SEARCH_STALE means restart. Incomplete scans require a narrower query.' + RESULT,
    grep: 'Search UTF-8 files below path relative to the current session cwd. pattern is ONE Rust regex string; filter files with glob, an ARRAY of relative globs ("!" excludes). There is no include field. Use summary for aggregate file/match totals, count for per-file counts, files_with_matches for paths, content for text (default); limit defaults to 100 items. Optional line context. Paging uses 0-based offset/nextOffset; prefer continuation with unchanged options. Each page rescans; SEARCH_STALE means restart. Check scanComplete and pageComplete; matchedTotal exists only after a complete scan, matchedObserved is a lower bound otherwise. skipReasons explains gaps. Narrow incomplete scans instead of blindly paging.' + RESULT,
    stat: 'Inspect one regular file: SHA-256 revision, bytes, UTF-8 lineCount (null for binary), timestamps and permissions; no content. Missing paths return exists:false, revision:absent.' + RESULT,
    diff: 'Read-only comparison of one UTF-8 file with content. Returns one prefix/suffix-trimmed replacement hunk (not a minimal diff), paged 0-based offset/limit (default 100). Includes old/new hashes and line counts; no publication.' + RESULT,
    write_file: 'Create or fully overwrite one UTF-8 file; parents must exist. Required expectedRevision is the observed SHA-256, or absent for create-only. Atomic CAS, short receipt with new revision/bytes/lineCount; dryRun only previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Read-only denies even dryRun. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
    edit_file: EDIT_DESCRIPTION,
    copy: 'Copy ONE regular file to absent to (relative to session cwd); parents must exist. Required expectedRevision checks source. Atomic no-clobber destination; preserves metadata or fails closed. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved. Darwin requires APFS cloning and currently refuses nonempty extended ACLs with METADATA_UNSUPPORTED before staging; use a dedicated metadata-aware tool for ACL-bearing files. No directories/links; recursive work uses ops_batch when available.' + RESULT,
    move: 'Move ONE regular file to absent to, same filesystem only. Required source expectedRevision. Atomic no-clobber destination then source unlink; failures after publication carry effectState:applied. No copy-delete fallback, directories or links.' + RESULT,
    remove: 'Unlink ONE regular file with required expectedRevision from inspect/stat. No recursion/directories/links. Atomic unlink; no trash. Read-only denies all mutations.' + RESULT,
    replace: 'Replace LITERAL text (pattern is not a regex) in UTF-8 files under path; glob filters files as in ops_grep. dryRun observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
});
