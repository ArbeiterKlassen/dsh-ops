# Native kernel workspace

中文版：[原生内核.md](原生内核.md).

The one-shot `dsh-ops-worker` remains the only executable. Each call enters through DSH's
subprocess and confinement services, rechecks authority, reads one bounded JSON request,
and writes one JSON result. Splitting the kernel does not introduce a persistent process.

| Crate | Responsibility | Kernel dependencies |
| --- | --- | --- |
| `ops-protocol` | Request, errors, job records, credential and ownership checks | None |
| `ops-files` | No-follow handles, reads, CAS publication, metadata, tree operations, directory sync | protocol |
| `ops-search` | Glob, grep and replacement orchestration over guarded file primitives | protocol, files |
| `ops-results` | Bounded generation store, result pages and immutable job-audit access | protocol, files |
| `ops-documents` | Strict bounded CSV/TSV Unicode decoding and typed positional rows | protocol, files |
| `ops-batch` | Plans, write-ahead transitions and conservative recovery | protocol, files, results |

The root crate routes requests and opens audit storage only for batch/result capabilities.
Job ownership checks live with the protocol record so results never depend on batch execution.
The existing Windows and Darwin metadata crates remain separate FFI boundaries; kernel crates
forbid unsafe Rust. Replacement keeps its observation locks until publication settles, and
batch execution persists the unknown state before filesystem effects. Read-only file calls do
not create audit storage.

Run `cargo test --workspace --locked --manifest-path native/Cargo.toml` to include the tests
moved into the new crates. `npm run build:ptc` still produces the same worker path. Published
packages include `native/crates/` and both metadata adapters so installed source builds work.
The benchmark preflight checks all workspace inputs while ignoring Cargo target directories.

## One-shot request protocol

New bridges send `{ version: 1, requestId, component, budget, request }`. `request` retains the
strict existing capability and host authority fields; `component` is `file` or `ptc` and never
grants authority. The bridge generates a fresh UUID, supplies the authoritative session/root and
policy, then rechecks authority immediately before spawning as before. Ordinary success fields
retain their semantics; optional reference fields are described below.

`budget.timeoutMs` accepts 1..2147483647 milliseconds for envelope compatibility. The host
uses a 30000ms default and caps supplied timeouts at 30000ms, with host cancellation. A process-local watchdog also enforces it for direct callers; interruption exits
124 and bridges report unknown effects. `budget.maxBytes` is 1024..131072, defaults to 131072, and
counts serialized JSON plus its newline. The minimum leaves room for a structured error. Oversized
read output without trusted storage returns `OUTPUT_LIMIT` with no effects; a lost mutation
receipt reports unknown effects
unless an existing failure already carries a more precise effect state. No automatic retry follows.

The complete request remains capped at 2 MiB. Explicit legacy unversioned requests remain accepted
for 0.3.x benchmark comparisons, with the same authority checks and bounded default transport budget.
Any envelope marker selects strict v1 decoding: partial envelopes, unknown fields, invalid IDs,
unsupported components/versions and unusable budgets are rejected before filesystem effects.
Request IDs do not change result hashes. Automatic output spill is described below.

## Session snapshot references (6a/16)

The worker accepts optional trusted envelope metadata `storage: { root, authorityId, allowedTools,
windowsWriteSid? }`. Tool arguments and the inner request cannot supply it. The host provides an
existing absolute cache root, a 64-character lowercase SHA-256 authority identity, and the current
canonical producer-tool allowlist. Its authority identity must bind the live session nonce and
current policy/credential boundaries; knowing a reference never grants authority. Each access also
rechecks scope, selected canonical root and directory identity, producer and current credential
fences. The trusted cache root is a cache-only grant independent of operation-root selections and business
write_roots. It is never added to the business mutation allowlist.

With this context, result put returns `ref://<encoded-session>/<tool>/<uuid>` and `reference`
metadata: refId, createdAt (epoch milliseconds), ttlMs, schemaVersion, producerTool, totalItems,
totalBytes (physical serialized snapshot bytes), and a preview of at most ten rows/512 characters.
The default `ttlMs: 0` means session lifetime; explicit positive TTLs are bounded to seven days.
The host must expire references on session exit and rotate the authority identity when reopening a
session. The worker caps snapshots at 10 MiB and each session cache at 100 MiB/4096 entries, counting
crash stages and unknown files. Writers serialize quota/LRU decisions with one shared OS lock.
Only exact snapshot UUID names are evicted; immutable audit records are never LRU candidates.

Pages return sourceTotal, filtered total, items, nextOffset, omitted and complete; complete means
all selected stored rows have been displayed, not that the original business traversal was complete.
The 512..65536-byte page budget includes JSON escaping, handle metadata and the newline. Oversized
rows require projection or a larger page; reference pages never create another reference. Nested
reference objects are refused, although ordinary strings containing a URI remain ordinary data.
Readonly pages acquire an existing shared lock without creating files or changing LRU timestamps.
Missing, expired, released or evicted snapshots return `REFERENCE_EXPIRED`. Legacy r-/j- access
retains its existing protocol and durable audit location.

On Windows the host supplies the actual private `--temp` root and `--temp-write-sid` from its
confined invocation, retaining that location for readonly access. Protected cache DACLs grant only
the current user and this exact private-temp capability, which must already exist on the held
parent. Public/logon/workspace capability SIDs are refused. Real readonly and foreign-session tokens
cannot write these objects. On POSIX, files/directories are current-user-owned and private. Cache
parents, directories, snapshots and the stable lock reject symlinks/reparse points; files must have
one hard link. No cache operation changes business-file permissions.

For host lifecycle cleanup, `result { action: "purge" }` with the same trusted storage context
accepts no other arguments. It removes only validated snapshot/stage names for that scope, retaining
the lock inode, directories and unknown/audit names. It returns `removed`, `retained`, `complete`
and `effectState`; partial cleanup failures identify prior effects. Readonly purge is refused.
The host must first invalidate references logically and await active calls; a denied or interrupted
purge is deferred cleanup, never a reason to rerun business operations. Host lifecycle hooks are
attached by the host integration slice.

## Automatic bounded output spill (6b/16)

With trusted storage, ordinary file/search/batch output that exceeds the serialized inline budget
keeps a bounded head and adds `reference` and `referenceRoot` (the canonical operation root).
Pass that original root when paging after cwd changes. Display `complete` is false; original
status, mutation counts/effects and scan coverage remain intact. Small outputs create no cache.
The worker captures the requested range/page, never silently broadens a query to the whole tree.

Reference pages include `source`: the original non-item execution facts, `root`,
`itemEncoding: "tagged-json-v1"`, `capturedItems` (logical items) and `captureComplete`.
Original scanComplete/matchedTotal, revision/range facts and continuation semantics remain there.
`page.complete` means that stored records have been displayed; it proves neither a complete scan
nor complete capture. For read_many, one logical item is the whole per-file receipt, including its
lines, revision, bounds and any failure. Per-file failures remain values.

Small records are `{ kind: "item", index, value }`. Large items become bounded
`{ kind: "item-json-chunk", index, chunk, byteOffset, text, complete }` records. `index` and
`chunk` start at zero; byteOffset counts UTF-8 bytes of the serialized logical JSON. Concatenate
text in chunk order and JSON.parse only after the final complete=true chunk. Verify contiguous
indices/offsets and final markers. StorageReference.totalItems counts physical records, while
source.capturedItems counts reconstructed logical items. Chunking occurs before display clipping,
so an inspected line's Unicode/control characters and suffix remain recoverable.

Capture is bounded below the 10 MiB physical snapshot quota. If one logical item cannot fit, all
of its chunks are discarded and only preceding whole items are stored; source.captureComplete is
false and storageError reports QUOTA_EXCEEDED. Narrow the query for the missing range. Capture
completion is independent of original scan completion. Reference pages never spill another handle.

A cache failure adds bounded `storageError: { code, message, effectState }`; its effectState refers
only to cache effects, separately from business status/changed/effectState. Readonly observation
cannot create a reference. Cache refusal retains an incomplete bounded head with range/hex recovery;
completed mutations must not be repeated. Reference metadata is budget-checked before publication,
so an unusably small head budget does not create an unreachable blob. Calls without trusted storage
retain the legacy transport contract; the host supplies recovery guidance when storage is unavailable.

## CSV/TSV worker observations (15a/16)

The new ops-documents crate handles `table_read` in the same one-shot worker. The capability stays outside
the default schema: Native uses `ops_discover` and PTC uses `ops_sdk` to activate `table_read`
for the next agent step. Siblings and descendants require their own selection. It adds no external packages:
serde/serde_json and sha2 reuse the existing locked workspace dependency graph. PDF/DOC parsing
requires separate dependency review.

Arguments are `{ path, format?, encoding?, header?, offset?, limit? }`. The host resolves path
against current cwd before sending an absolute path. Format is csv or tsv, inferred as tsv only
for a .tsv extension (case-insensitive), otherwise csv. Encoding defaults to utf-8; utf-16le and
utf-16be are explicit alternatives. Valid matching BOMs are consumed, contradictory BOMs and
malformed Unicode are rejected without replacement decoding. Without a BOM the explicit encoding
is authoritative; no unreliable byte-pattern guessing is performed.

Header defaults true. Duplicate/empty column names remain positional; header=false returns an
empty columns array and infers columnCount from the first record. Data rows are
`{ row, cells: string[], lineStart, lineEnd }`: row is 1-based excluding the header, while lineStart
and lineEnd count physical LF lines including the header and quoted multiline fields. Values are
never guessed as numbers, dates or booleans. Quoted fields support delimiters, escaped double quotes
and exact embedded LF/CRLF. Record separators are LF/CRLF; bare CR outside quotes, trailing text
after a closing quote, unquoted quotes and inconsistent widths are errors. Blank records contain
one empty cell; a final newline adds no phantom record. Empty files have zero rows.

Offset is 1..100000 data rows, default 1; limit is 1..1000, default 200. Each call streams a bounded
physical scan, retains only its requested rows, and reports rowsObserved, bytesRead (including
bounded decoder read-ahead), scanComplete and pageComplete separately. rowCount/total and the
raw-byte SHA-256 revision appear only after a clean EOF with unchanged observed file metadata.
Complete also requires no remaining rows after the requested page. A malformed suffix preserves
preceding valid rows with status=partial/error and no invented total, even when the requested page
was already fully observed. Metadata changes invalidate the complete-scan claim.

Hard limits are 32 MiB input, 100000 data records plus one bounded EOF lookahead, 1 MiB decoded
record, 1024 columns, 8192 serialized header bytes and 30 seconds between records (the host/worker
request deadline also applies). A stopped scan returns explicit scan-budget/time recovery; row
paging does not bypass these physical limits. Use a dedicated streaming table reader for larger
inputs. Error codes include TABLE_PARSE_ERROR, ERR_INVALID_ENCODING, OUTPUT_LIMIT, FILE_CHANGED
and DEADLINE_EXCEEDED; preflight authority failures keep the existing policy codes.

Credential and no-follow checks reuse ops-files. Readonly observations create no audit/cache
objects. Oversized requested rows use the existing bounded spill sink before display clipping:
references contain exact typed row JSON, source retains table/coverage facts, and captureComplete
is independent of scanComplete. Page with the original referenceRoot. Cache effects never imply
business writes; table_read is classified as read-only even in a writable session.

Native renders positional JSON cells with physical LF ranges and explicit non-exhaustive gap notices.
PTC exposes lexical `string[]` cells through generated declarations. Stable complete scans with
remaining rows supply read-only forward continuations; callers must compare revisions across calls.
Malformed/changed input and physical scan limits retain prefix data and recovery advice, with no
continuation that would repeat the same gap. Native reference pages and PTC result pages preserve
original table coverage separately from stored-row pagination. Shared admission, current authority,
credential checks, cancellation and storage bindings apply unchanged.

## Bounded DOCX main-body observations (15b/16)

`doc_read` is a worker-only capability in this slice; later host/discovery integration remains
separate. Arguments are `{path, offset?, limit?}`: path must be absolute after host resolution
against current session cwd; offset is a 1-based paragraph index (1-100000, default 1), limit is
1-1000 (default 200). Each item is `{block,type:"paragraph",text}`; table paragraphs additionally
carry 1-based table/row/cell coordinates. Empty paragraphs are retained. Tabs, line breaks,
Unicode, entity references and lexical spaces are preserved. Formatting and rendered layout,
headers/footers, footnotes/endnotes, comments and package metadata are explicitly excluded in
`scope:"main-body-paragraphs"` and `excludedContent`. A complete result describes that scope,
not the full rendered document. There is no Office automation or external relationship fetch.

The subset requires a standard internal word/document.xml main part, stored/deflated ZIP,
strict UTF-8 or BOM-marked UTF-16 and recognized transitional/strict Word namespaces. Binary DOC,
macros, encrypted/multi-disk/ZIP64 archives, nested tables, body drawings, fields, revisions,
foreign/unknown body content and malformed structures are explicitly refused. Ambiguous ZIP footer
signatures anywhere in the raw archive are conservatively refused before constructor recovery. A late content
failure returns preceding complete paragraphs with `status:partial`, `scanComplete:false`, no
full total/revision, and recovery guidance. XML never resolves DTD/custom/external entities.

Bounds apply before library allocation/decompression: archive 32 MiB; central directory 1 MiB
and 4096 entries; each OPC metadata part 1 MiB; main XML 8 MiB actual decoded bytes; one paragraph
1 MiB UTF-8; 100000 observed paragraphs; XML depth 128, attributes 64 per element, namespace
bindings 512 in scope; 30 seconds between parse events plus the transport watchdog. Each fixed
XML part is CRC-checked after bounded decompression. ZIP local/central headers, uniqueness and
nonoverlap are preflighted; nothing is extracted to disk. Selected pages alone are retained.

`blocksObserved`, `scanComplete`, `pageComplete` and `complete` separate scan coverage, requested
page coverage and remaining paragraphs. `total`, raw-file SHA-256 `revision` and `omitted` are
available only after a stable complete scan; `nextOffset` is always 1-based. Paging rescans the
same file, so callers must compare revisions before combining changing observations. It does
not bypass physical scan limits. The existing spill sink captures requested full paragraphs
before inline clipping, including long Unicode text. Reference pages retain scope/coverage and
captureComplete; their own complete flag describes stored-record pagination. Use referenceRoot
for paging. Reads repeat authorization/no-follow/credential checks and create no artifacts in
read-only sessions; transport or cache failures never imply a business mutation.

Exact dependency versions, release dates, rationale and original notices are recorded in
[document-dependencies.md](document-dependencies.md).
