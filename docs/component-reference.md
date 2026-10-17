# Component reference

What each of the five bundle components publishes, with parameters and permission requirements.

---

## Components at a glance

| Row `name` | Description | Default | Published tools |
| --- | --- | --- | --- |
| `dsh-ops/shell` | Prefer bash as the terminal, with PowerShell 7 for operations bash cannot cover | Windows only | `ops_bash`; host `pwsh` uses bundled PowerShell 7 |
| `dsh-ops/file` | Native Rust file operations with bounded results | On | Eleven native file tools |
| `dsh-ops/ptc` | Independent Rust safe batches and bounded result references, only in pure PTC sessions | On (PTC-only publication) | `ops_batch`, `ops_result` |
| `dsh-ops/hide-official` | Strict scoped official-tool takeover | Off (opt-in) | No tools; verified restrictions and execution guard |
| `dsh-ops/tui` | Read-only current-session OPS sidebar | Off | None; see [sidebar guide](tui-panel.md) |

The former `dsh-ops/background` component (FastCtx background jobs: `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) has been removed. A profile row that still names it loads as a no-op: it accepts any config, publishes nothing, and logs one warning that the row can be deleted.

## Current integration contract (local, not a release)

The bundle has **five independent components**: shell (Windows only), file and PTC are enabled by default; the read-only TUI sidebar and strict official-tool hiding are opt-in. Linux/macOS omit the shell row at activation and retain official `bash`; Windows provides foreground `ops_bash` and retains official `pwsh`. PTC publishes only `ops_batch`/`ops_result` in verified pure PTC presentation.

The file worker implements eleven bounded tools: inspect, glob, grep, stat, diff, literal replace, CAS create/overwrite, exact edit, and single-file copy/move/remove. Windows overwrite/edit/replace/copy preserve owner/group/ordered DACL and supported basic attributes/timestamps. Readonly overwrite and unsupported metadata fail honestly before publication (`METADATA_UNSUPPORTED` for named streams, EA and special storage); SACL/audit labels are outside this contract. macOS overwrite/copy use APFS metadata-preserving clones; unsupported filesystems fail closed. Directories, recursive mutation, DOC/PDF, web/UI, and orchestration replacements are not implemented. No `ops_process_*` tools are registered; the unsafe background-process lane was withdrawn. The old FastCtx background entry remains compatibility-only, outside the five-row bundle.

**Strict full-stack takeover is readiness-blocked**, not delivered: only official read/glob/grep have reviewed mappings. Unsupported official capabilities, missing OPS tools, own-scope official schemas, or unhideable `run_code` produce `READINESS_BLOCKED` (executor infrastructure, not `POLICY_DENIED`). Only the affected scope is blocked; healthy independent/ancestor scopes keep their verified masks. Assembly verification errors invalidate that scope snapshot and retry on the next request without removing the mask. There is no silent mixed-mode continuation. The hiding row is disabled by default; enable it only for a verified complete deployment. This is not automatic fallback. PTC with hiding enabled is blocked on the pinned host because reserved `run_code` cannot be hidden.

Every operation resolves DSH sandboxPolicy and uses host subprocess governance, cancellation and credential scrubbing. Fixed data-only file operations use the trusted file-policy fence and no-follow/CAS worker, not arbitrary code execution. Guidance is live and scoped, outputs bounded, and receipts/pages carry hashes, bytes, line counts or source counts where implemented. See [component reference](component-reference.md), [configuration](configuration-reference.md), and [local benchmark](benchmark.md). Benchmark token estimates are not demonstrated end-to-end token savings; no Desktop GUI or POSIX deployment acceptance is claimed.

---

## Tool summary

| Tool | Purpose | Full-access requirement |
| --- | --- | --- |
| `ops_inspect_local_file` | Bounded UTF-8 lines and hex | No command permission gate¹ |
| `ops_grep` | Rust regex search, multiple file filters, counts/summaries | No command permission gate¹ |
| `ops_glob` | Multiple path patterns with exclusions | No command permission gate¹ |
| `ops_replace` | Mechanical cross-file literal replacement | No command permission gate¹ |
| `ops_write_file` / `ops_edit_file` | Full UTF-8 write / exact original-text patch with explicit CAS | DSH file policy¹ |
| `ops_stat` / `ops_diff` | SHA-256 metadata / bounded proposed-content comparison | Read-only allowed |
| `ops_copy` / `ops_move` / `ops_remove` | One regular file, source CAS; destination absent | DSH file policy¹ |
| `ops_bash` | Preferred general bash command executor; `command` for short commands, `script_path` for long scripts | Confined in restricted modes; matched Windows x64 private IPC runtime |
| `ops_batch` | Preflight and execute copy / move / remove with audit and recovery | See the PTC notes |
| `ops_result` | Bounded result references: put, page, release | See the PTC notes |
| Host `pwsh` | Windows-native operations using bundled PowerShell 7 | Host policy |

¹ **Fixed file operations use a trusted-operation policy fence, matching DSH fs-sandbox, not arbitrary-code isolation.** OS-readable paths are readable in all modes; read-only rejects every mutation (including mutation dry-runs), workspace-write permits writes under the workspace and this session’s private temporary directory, and full access adds no write fence. The fixed Rust worker uses host subprocess governance plus no-follow traversal, budgets and CAS. Bash/run_code still require OS confinement; no unconfined fallback exists. On Windows, owned workspaces automatically receive directory-only WRITE_OWNER for the host grant prerequisite, with DACL backups; no recursive ACL edits or ownership changes. That preparation runs the package's own script as the current user before sandbox confinement applies, only in workspace-write, with `-ExecutionPolicy Bypass` (Group Policy still wins).

---

## `dsh-ops/file` — file tools

All file tools resolve relative paths against the DSH session cwd, accept a single `path`, and expose no `root`, `workspace`, `cwd` or `file_path` alias. All are UTF-8 first with bounded output; glob and grep do not traverse symlinks, junctions, reparse points, hidden files or `.git`.

When the host provides its `fs` service, `ops_inspect_local_file`/`ops_stat` observations and completed mutations (including removed-path absence) are recorded in the host's read-before-edit table (`fs/observed`) exactly like host `read`/`edit`: a file read with ops can be edited with host `edit` directly, and an ops write does not make the host's earlier read look like an external change. `ops_grep`, `ops_glob` and `dryRun` record nothing.

### `ops_inspect_local_file`

Read bounded UTF-8 text lines, or a hex view of one path. Directories are rejected — use `ops_glob` or `ops_grep` instead.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Resolved against the DSH session cwd |
| `offset` | integer ≥ 1 | First line |
| `limit` | integer 1–10000 | Maximum lines returned |
| `encoding` | `utf-8` | Encoding |
| `view` | `text` \| `hex` | View mode |

### `ops_glob`

Find regular files below `path`. `pattern` is an **array** of globs matched segment by segment against paths relative to `path` (ASCII case-insensitive), e.g. `["**/*.md","!vendor/**"]`: `*.md` matches the top level only and `**/*.md` any depth; a `!` prefix excludes, and at least one positive entry is required. A bare string is rejected; there is no `include` field.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Search root |
| `pattern` | string[] (required, ≥1) | Glob patterns |
| `outputMode` | `paths` \| `details` | Output shape |
| `sort` | `path` \| `modified` | Ordering |
| `offset` | integer | Paging start |
| `limit` | integer 1–10000 | Maximum entries |

### `ops_grep`

Search UTF-8 files below `path` with Rust regex, bounded output, paging and optional line context. `pattern` is **one** regex string; filter files with `glob`, an array in the same syntax as `ops_glob`. **There is no `include` field.** `glob` may contain only exclusions ("everything except"); when `path` is a single file, `glob` is ignored.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Rust regex |
| `path` | string | Search root |
| `glob` | string[] | Restrict files |
| `outputMode` | `files_with_matches` \| `content` \| `count` \| `summary` | Output shape |
| `caseInsensitive` | boolean | Ignore case |
| `lineNumbers` | boolean | Show line numbers |
| `beforeContext` / `afterContext` | integer ≤ 32 | Context lines |
| `multiline` | boolean | Multi-line matching |
| `offset` / `limit` | integer 1–10000 | Paging |

### `ops_replace`

Perform a deterministic UTF-8 replacement under `path`. `pattern` is **literal text, not a regex**; `glob` works as in `ops_grep`. `dryRun` observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Literal text |
| `replacement` | string (required) | Replacement text |
| `path` | string | Operation root |
| `glob` | string[] | Restrict files |
| `maxReplacements` | integer 1–100000 | Hard replacement limit |
| `dryRun` | boolean | Never writes |

### Single-file writes, edits, metadata and transfers

- `ops_stat {path}` returns `exists`, SHA-256 `revision`, `bytes`, UTF-8 `lineCount` (empty=0; trailing newline adds no phantom line; binary=null), `modifiedMs`, `readonly`, and POSIX `mode`. An absent leaf returns `revision:"absent"`. Parents must exist. Inspect returns the same whole-file revision/bytes/lineCount even on a partial page.
- `ops_write_file {path, content, expectedRevision, dryRun?}` creates or fully overwrites UTF-8 bytes. `expectedRevision` is the observed lowercase SHA-256; `"absent"` is create-only, never an overwrite wildcard. Empty content is valid. Parent directories are not created implicitly.
- `ops_edit_file {path, expectedRevision, edits:[{oldText,newText}], dryRun?}` applies 1–100 exact patches against the **same original bytes**, not sequential intermediate text. Every nonempty `oldText` must occur exactly once (overlapping occurrences are ambiguous); overlapping edits reject the entire request. `newText:""` deletes. CRLF, Unicode and BOM are literal, never normalized.
- `ops_diff {path, content, offset?, limit?}` is read-only: one prefix/suffix-trimmed replacement hunk, **not** a minimal/unified diff. Items identify added/removed lines (including terminators); 0-based `offset`, default limit 100, maximum 1000. `before`/`after` carry exact hash/bytes/lineCount. Follow `nextOffset` and `truncated`; a truncated long line requires a narrower proposal, not blind inference from missing text.
- `ops_copy` / `ops_move` take `{path,to,expectedRevision}`. Both paths resolve against session cwd. Only regular files are supported; parents must exist, destination must be absent (atomic no-clobber). Copy reads the source under CAS and publishes an independent inode. Move uses a same-filesystem hard-link publish followed by source unlink; cross-device move is `CROSS_DEVICE`, with **no** copy/delete fallback. A published destination followed by source-unlink/sync failure reports `effectState:"applied"`; inspect both paths, never repeat blindly.
- `ops_remove {path,expectedRevision}` atomically unlinks one regular file; no trash or recursive directory removal. Directory batching belongs to `ops_batch` when available.

Write/edit receipts are short and content-free: `revision`, `bytes`, `lineCount`, `changed`, `dryRun`, `items` with previous revision/bytes and metadata. Source revision checks and stable per-path sidecar locks serialize cooperating native writers across atomic inode replacement; advisory locks do not stop unrelated external writers. New files use private preparation and atomic no-clobber publication; POSIX overwrite preserves mode/ACL and reports owner/xattr restore warnings. Copy fails rather than publish if captured metadata cannot be restored (timestamps retained). Move retains inode metadata. Requests are capped at 2 MiB, file reads at 32 MiB, responses at roughly 96 KiB; host cancellation/deadlines remain authoritative. No shell fallback exists.

**Metadata contract:** Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps. Readonly overwrite is refused; ADS, EA and special storage return `METADATA_UNSUPPORTED` before publication. SACL/audit labels are outside this contract. Darwin overwrite/copy require an APFS metadata-preserving clone; unsupported filesystems fail closed. These are implementation limits, not authorization denials.

### Results and errors

- **File tools, `ops_batch` and `ops_result` never throw.** Failures resolve as values with `status` `"error"` or `"rejected"` (authorization refusal) plus `error.code` / `error.message` / `error.nextAction`; success is `"completed"` (`ops_batch` also reports `planned` and related states). In PTC, a `try/catch` alone misses these failures — check `status`.
- **`ops_bash`** resolves command results as values: `status` (`completed` only for exit code 0 with no error, permission refusal, signal or timeout; otherwise `failed`), `exitCode`, `stdout` / `stderr`, `error`, `permission`. It throws (a `ToolCallError` in PTC) only for **invalid arguments** or an **unavailable executor**.
- Host tools (`read` / `write` / `edit` / `pwsh` …) throw `ToolCallError` on failure.

---

## `dsh-ops/ptc` — native batches and result references

Loaded only in pure PTC sessions, off by default.

### `ops_batch`

Preflight and verify copy / move / remove.

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `plan` \| `run` \| `resume` (required) | Action |
| `root` | string | Defaults to session cwd; when supplied it must be an absolute path (a relative root is rejected at preflight with `INVALID_ARGUMENT`) |
| `operations` | array, ≤512 items | Each item: `op` (`copy`/`move`/`remove`) + `path` + `to` |
| `operationsRef` | string | Reference a stored operation list |
| `protect` | string[], ≤128 items | Protected paths |
| `id` | string | The existing plan for `resume` |

> `action=plan` requires `operations` and creates a no-effect audit plan; execute that exact plan with `action=resume` plus `id` (**do not change it to `run`**). `action=run` requires `operations` and executes immediately. Operations use relative `/` paths, with no overwrite or link traversal. Page a plan's `detailsRef` with `ops_result`, passing the same `root` when it differs from the session workspace root (otherwise the page returns `NOT_FOUND`).

### `ops_result`

Bounded session-owned result references: put object rows, page with top-level `equals`/`fields` and quantity/byte budgets, release results. 24h expiry. Job audits are read-only. References are observations, never authority.

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `put` \| `page` \| `release` (required) | Action |
| `items` | object array, ≤10000 items | Rows for `put` |
| `root` / `id` | string | Operation root and result id |
| `offset` | integer ≥ 0 | Paging start |
| `limit` | integer 1–512 | Rows per page |
| `maxBytes` | integer 512–65536 | Byte budget per page |
| `fields` | string[], ≤32 items | Projected fields |
| `equals` | object | Top-level filter |

---

## `dsh-ops/shell` — terminal and shells

Routing: **toolkit → bash → PowerShell 7**.

- `ops_bash`: the preferred general command executor. Use `command` for short commands and `script_path` for long scripts.
- Host `pwsh`: Windows-native operations, using bundled PowerShell 7.

"Prefer bash as the terminal" means prompting the model to use `ops_bash` first; it **does not change the system default terminal, PATH or existing host shell tool names**. When the shell component is on, the official configuration lifecycle temporarily sets the PowerShell 7 path for `pwsh-sandbox`; when off, it restores the executor's latest original configuration without writing profile configuration. Switching executor configuration does not cancel already-running host commands.

The routing table the model sees is rendered by the plugin from what it actually published:

```
# Shell routing: bash → PowerShell 7

| Task | Tool |
| --- | --- |
| Bounded UTF-8 lines / hex | ops_inspect_local_file |
| Images | read_image (host) |
| Search contents | ops_grep |
| Find paths | ops_glob |
| Batch literal replacement | ops_replace |
| Full UTF-8 write / precise patch (CAS) | ops_write_file / ops_edit_file |
| Revision / metadata / proposed-content comparison | ops_stat / ops_diff |
| Single regular-file copy / move / unlink (CAS) | ops_copy / ops_move / ops_remove |
| General commands / builds / git / pipelines / scripts — preferred command executor | ops_bash |
| Windows-native cmdlets / registry / services only | pwsh (bundled PowerShell 7 via host) |
```

---

## See also

- [Configuration reference](configuration-reference.md) — keys and owning components
- [Usage](usage.md) — install, update, remove, CLI
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
- [Native PTC](native-ptc.md) — the PTC design and build


## `dsh-ops/hide-official` — strict official-tool takeover

This independent component is enabled by default. It removes official capabilities
from each live agent's actual registry/schema surface using `agent.ctx.tools.restrict`,
not prompt advice or a shared registry override. Windows retains only official `pwsh`;
Linux/macOS retain only official `bash`, and the shell component defaults off there.
Unrelated third-party tools remain untouched. Disabling the whole hiding row restores
its restrictions and guard without changing other components.

Configuration is validated in `lib/config.js`: `strict` defaults to `true` and **cannot
be false**. `additionalOfficialTools: []` lists deployment-renamed official tools
(e.g. a custom `subagent` or `workflow` alias); it is not a replacement mapping.
The pinned host catalog and dynamic official prefixes live in
`lib/official-tool-catalog.js`. Host APIs expose names, not provider provenance:
new official names or custom aliases must be reviewed and registered in that catalog.

Before installing any masks, every visible official capability must have a reviewed,
implemented equivalent in `OFFICIAL_REPLACEMENTS`, and all eleven native file tools
must be visible. A same-named `ops_*` tool is not proof of equivalence. Currently only
`read`, `glob`, and `grep` have reviewed mappings. **Full-stack takeover is blocked on
missing equivalents** for write/edit/image, web, delegation, interaction, jobs and other
host capabilities; this component does not implement those replacements.

Failure rejects agent prompt assembly and denies tool execution with an
`READINESS_BLOCKED` / `EXECUTOR_UNAVAILABLE` diagnostic (not a user-authorization denial). No partial hiding
or silent official/OPS mixing is permitted. Readiness is checked per scope (including inherited masks); failed children/siblings do not poison healthy ancestors or unrelated roots. Verified masks remain installed on retryable assembly verification errors.
The monotonic guard still denies execution even if a later pre-execute listener allows.

`run_code` is an official tool, **not an exception**. The pinned host reserves it outside
restriction layers, so a PTC/both agent fails closed with an unhideable-transport diagnostic.
Use a verified native presentation or change the host API before enabling takeover for
that agent; this component does not force a presentation mode. Own-scope official tool
registrations that `restrict` cannot hide likewise block assembly. Tool changes trigger
live reconciliation; unload and agent disposal lift all owned restrictions.

### Authority and execution errors

Only native `POLICY_DENIED` with `reason: read-only|write-roots` (or explicit host policy preflight) receives selector advice. Legacy/unknown-reason denials pass through unchanged. `CREDENTIAL_DENIED` is a credential fence no selector removes; `PATH_RESTRICTED` is no-follow/path policy. `AUTHORITY_CHANGED` stops before spawn when the snapshot changes but the request remains allowed; refresh context before a new call. Stderr signatures prove only `EXECUTION_RESTRICTED` with unknown effects and no selector advice (Bash returns `restriction`, not `permission`). Cancellation is failed even at exit zero and renders `[cancelled]`. Never bypass confinement or blindly retry unknown/applied effects.
