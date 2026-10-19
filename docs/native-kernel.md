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
policy, then rechecks authority immediately before spawning as before. Success JSON is unchanged.

`budget.timeoutMs` is 1..2147483647 milliseconds, using the existing 300000ms default and existing
host cancellation. A process-local watchdog also enforces it for direct callers; interruption exits
124 and bridges report unknown effects. `budget.maxBytes` is 1024..131072, defaults to 131072, and
counts serialized JSON plus its newline. The minimum leaves room for a structured error. Oversized
read output returns `OUTPUT_LIMIT` with no effects; a lost mutation receipt reports unknown effects
unless an existing failure already carries a more precise effect state. No automatic retry follows.

The complete request remains capped at 2 MiB. Explicit legacy unversioned requests remain accepted
for 0.3.x benchmark comparisons, with the same authority checks and bounded default transport budget.
Any envelope marker selects strict v1 decoding: partial envelopes, unknown fields, invalid IDs,
unsupported components/versions and unusable budgets are rejected before filesystem effects.
Request IDs do not change result hashes. Scan/storage/reference budgets are separate later work.
