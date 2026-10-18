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

`budget.timeoutMs` is 1..2147483647 milliseconds, using the existing 300000ms default and existing
host cancellation. A process-local watchdog also enforces it for direct callers; interruption exits
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
